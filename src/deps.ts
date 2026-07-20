import type { RuntimeConfig, ModuleFormat, FileKind } from './types';
import { ModuleResolver } from './resolve/index';
import { errMsg, log, getMemoryTier, PrecacheProgress, npmPackageName, isRelative, isAbsolute, parentDirKey, yieldEventLoop } from './utils';
import { isRemote } from './source/cache';
import type { OxcTranspiler } from './oxc';
import { ImportScanner } from './import-scanner';
import { isParseWorkerError } from './parse';
import { isScannablePath, isWasmPath } from './scan';

const os = import.meta.use('os');

// Batch size / wall budget before flush+yield (UI needs macrotasks to paint).
const SCAN_BATCH_ITEMS = 32;
const SCAN_BATCH_MS = 16;

// Parallel BFS — full scan, no lock deps shortcut

export interface ScanResult {
    visited: number;
    downloaded: number;
    errors: Array<{ spec: string; parent: string; error: string }>;
    modules: Array<{
        specPath: string;
        localPath: string;
        format: ModuleFormat;
        fileKind?: FileKind;
        remote: boolean;
    }>;
    // node_modules edges (npm: child + eligible parent); see isEligibleParent().
    edges: Array<{ parentSpecPath: string; name: string; childSpecPath: string; childLocalPath: string }>;
    /** Complete resolver edges for consumers that need an offline module graph. */
    resolutions: Array<{ parentSpecPath: string; specifier: string; childSpecPath: string }>;
}

export interface DepScannerOptions {
    /** Traverse cross-package npm imports and retain every resolved edge. */
    fullGraph?: boolean;
    /** Print the generic scan module-count summary. */
    reportSummary?: boolean;
    /** Resolve an edge but omit the matched module and its descendants. */
    excludeSpecPath?: (specPath: string) => boolean;
    /** Caller-provided kind for modules with explicit language metadata. */
    fileKindOverrides?: ReadonlyMap<string, FileKind>;
}

/** Parents worth recording node_modules edges for: real npm packages, and the
 *  synthetic project-root markers used to seed top-level scans. */
function isEligibleParent(parent: string): boolean {
    return parent.startsWith('npm:') || parent.endsWith('/<cache>') || parent.endsWith('/<entry>');
}

function barePackageName(spec: string): string | null {
    if (!spec ||
        isRelative(spec) ||
        spec.startsWith('/') ||
        spec.startsWith('#') ||
        /^[a-z][a-z0-9+\-.]*:/i.test(spec)) {
        return null;
    }
    if (spec.startsWith('@')) {
        const firstSlash = spec.indexOf('/');
        if (firstSlash <= 1) return null;
        const secondSlash = spec.indexOf('/', firstSlash + 1);
        return secondSlash === -1 ? spec : spec.slice(0, secondSlash);
    }
    const slash = spec.indexOf('/');
    return slash === -1 ? spec : spec.slice(0, slash);
}

function shouldEnqueueScannedImport(parentSpecPath: string, spec: string, fullGraph: boolean): boolean {
    // Pack needs the complete transitive closure in the container; precache prunes
    // cross-package npm imports (the npm tree is materialized/cached separately).
    if (fullGraph) return true;
    if (!parentSpecPath.startsWith('npm:')) return true;
    const childPackage = barePackageName(spec);
    if (!childPackage) return true;
    return childPackage === npmPackageName(parentSpecPath);
}

function isImportScannable(localPath: string, fileKind?: FileKind): boolean {
    return fileKind === 'source' || fileKind === 'wasm' ||
        isWasmPath(localPath) || isScannablePath(localPath);
}

export class DepScanner {
    private readonly seen = new Set<string>();
    private readonly errs: ScanResult['errors'] = [];
    private readonly found: ScanResult['modules'] = [];
    private readonly edges: ScanResult['edges'] = [];
    private readonly resolutions: ScanResult['resolutions'] = [];
    private downloaded = 0;
    private readonly importScanner: ImportScanner;
    private lastStallLogMs = 0;

    constructor(
        private readonly resolver: ModuleResolver,
        private readonly cfg: RuntimeConfig,
        private readonly prog: PrecacheProgress | null = null,
        private readonly oxc: OxcTranspiler | null = null,
        private readonly parseImports: ((localPath: string) => Promise<string[]>) | null = null,
        private readonly options: DepScannerOptions = {},
    ) {
        this.importScanner = new ImportScanner(cfg.enableOxc !== false ? oxc : null);
    }

    async scan(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult> {
        this.init();
        // Seed with the entry file — resolveAsync will handle local file resolution
        return this.queueLoopInternal([{ spec: entrySpecPath, parent: `${os.cwd}/<entry>` }]);
    }

    /** BFS from an explicit specifier set (no entry file). */
    async scanFromSpecifiers(specifiers: string[], parentDir: string): Promise<ScanResult> {
        this.init();
        if (!specifiers.length) {
            return { visited: 0, downloaded: 0, errors: [], modules: [], edges: [], resolutions: [] };
        }
        const parent = `${parentDir}/<cache>`;
        const seeds: Array<{ spec: string; parent: string }> = [];
        for (const spec of specifiers) {
            seeds.push({ spec, parent });
        }
        return this.queueLoopInternal(seeds);
    }

    /** BFS entry graph + extra specs (e.g. devDeps for `cno cache`). */
    async scanEntryAndSpecifiers(entrySpecPath: string, entryLocalPath: string, specifiers: string[], parentDir: string): Promise<ScanResult> {
        this.init();
        const seeds: Array<{ spec: string; parent: string }> = [
            { spec: entrySpecPath, parent: `${os.cwd}/<entry>` },
        ];
        const parent = `${parentDir}/<cache>`;
        for (const spec of specifiers) seeds.push({ spec, parent });
        return this.queueLoopInternal(seeds);
    }

    private init(): void {
        this.seen.clear();
        this.errs.length = 0;
        this.found.length = 0;
        this.edges.length = 0;
        this.resolutions.length = 0;
        this.downloaded = 0;
    }

    /** Concurrent BFS: pull/resolve/enqueue without batch barriers. */
    private async queueLoopInternal(
        seeds: Array<{ spec: string; parent: string }>,
    ): Promise<ScanResult> {
        // Queue holds specifiers to resolve (spec, parentSpecPath)
        const queue: Array<{ spec: string; parent: string } | undefined> = [];
        let queueHead = 0;
        // pending counts items not yet fully processed (queued + active).
        let pending = 0;
        let fatalWorkerError: Error | null = null;
        const wakeWaiters: Array<() => void> = [];

        const wake = () => {
            const waiters = wakeWaiters.splice(0);
            for (const fn of waiters) fn();
        };

        const enqueue = (spec: string, parent: string) => {
            if (fatalWorkerError) return;
            queue.push({ spec, parent });
            pending++;
            wake();
        };

        // Seed the queue
        for (const seed of seeds) {
            enqueue(seed.spec, seed.parent);
        }

        // Guard: empty seed list — nothing to do
        if (pending === 0) {
            return { visited: 0, downloaded: 0, errors: [], modules: [], edges: [], resolutions: [] };
        }

        // parseImports is the worker (or async) scanner; null → sync ImportScanner.
        const syncScan = this.parseImports === null;
        // Local resolve+oxc-scan is sync on main. Extra pool slots only help when
        // edges hit network or worker scan; pure local graphs want a tiny pool.
        const CONCURRENCY = !syncScan
            ? ({ low: 4, normal: 12, high: 24 }[getMemoryTier()] ?? 12)
            : ({ low: 1, normal: 2, high: 4 }[getMemoryTier()] ?? 2);
        // Dedupe identical edges for precache. fullGraph/pack must keep every
        // parent edge in resolutions — only collapse same-dir relative fan-in
        // when we do not need per-parent resolution records.
        const fullGraph = this.options.fullGraph === true;
        const queuedKeys = new Set<string>();
        const edgeKey = (spec: string, parent: string): string => {
            // Same parentDirKey as ModuleResolver.exactResolveKey (shared helper).
            if (!fullGraph && isRelative(spec)) return `${spec}\0${parentDirKey(parent)}`;
            return `${spec}\0${parent}`;
        };
        const nextItem = async (): Promise<{ spec: string; parent: string } | null> => {
            while (queueHead >= queue.length) {
                if (fatalWorkerError) return null;
                if (pending === 0) return null;
                await new Promise<void>(resolve => { wakeWaiters.push(resolve); });
            }
            if (fatalWorkerError) return null;
            const item = queue[queueHead];
            queue[queueHead++] = undefined;
            return item ?? null;
        };

        const enqueueEdge = (spec: string, parent: string) => {
            const key = edgeKey(spec, parent);
            if (queuedKeys.has(key)) return;
            queuedKeys.add(key);
            enqueue(spec, parent);
        };

        // Seeds already enqueued above — mark so re-seed / re-import is skipped.
        for (const seed of seeds) queuedKeys.add(edgeKey(seed.spec, seed.parent));

        // Yield the event loop so timers (progress paint, etc.) can run.
        // Progress only receives state updates — never paint calls from here.
        const prog = this.prog;
        let batchItems = 0;
        let batchStartedMs = Date.now();
        const maybeYieldBatch = (): Promise<void> | undefined => {
            batchItems++;
            if (batchItems < SCAN_BATCH_ITEMS && Date.now() - batchStartedMs < SCAN_BATCH_MS) {
                return undefined;
            }
            batchItems = 0;
            batchStartedMs = Date.now();
            return yieldEventLoop();
        };

        const processEdge = async (item: { spec: string; parent: string }): Promise<void> => {
            let didDownload = false;
            // Always update the light activity label (incl. relatives). Only bare
            // / remote specs use the heavier startResolve Map for download rows.
            prog?.setActivity(item.spec);
            const trackProgress = prog !== null && !isRelative(item.spec);
            const baseProgress = trackProgress ? prog.onDownloadProgress(item.spec) : undefined;
            const onProgress = baseProgress
                ? (now: number, total: number) => { didDownload = true; baseProgress(now, total); }
                : undefined;
            const startedMs = Date.now();
            let resolvedMs = 0;
            if (trackProgress) prog.startResolve(item.spec);

            try {
                // Relative/absolute local edges never download — keep them sync.
                const info = (isRelative(item.spec) || isAbsolute(item.spec) || item.spec.startsWith('file:'))
                    ? this.resolver.resolve(item.spec, item.parent)
                    : await this.resolver.resolveAsync(item.spec, item.parent, undefined, onProgress);
                resolvedMs = Date.now() - startedMs;
                if (didDownload) this.downloaded++;
                prog?.bumpResolved();
                if (fullGraph) {
                    this.resolutions.push({
                        parentSpecPath: item.parent,
                        specifier: item.spec,
                        childSpecPath: info.specPath,
                    });
                }
                if (this.options.excludeSpecPath?.(info.specPath) === true) return;
                const fileKind = this.options.fileKindOverrides?.get(info.specPath) ?? info.fileKind;

                // Always record edge (per-parent node_modules link). Use resolved npm: path.
                if (info.specPath.startsWith('npm:') && isEligibleParent(item.parent)) {
                    const name = npmPackageName(info.specPath);
                    const parentName = item.parent.startsWith('npm:') ? npmPackageName(item.parent) : null;
                    // Skip self-deps (pkg → pkg/...) — soft mode would self-link forever.
                    if (name && name !== parentName) {
                        this.edges.push({
                            parentSpecPath: item.parent,
                            name,
                            childSpecPath: info.specPath,
                            childLocalPath: info.localPath,
                        });
                    }
                }

                if (!this.seen.has(info.specPath)) {
                    this.seen.add(info.specPath);
                    this.found.push({
                        specPath: info.specPath,
                        localPath: info.localPath,
                        format: info.format,
                        fileKind,
                        remote: isRemote(info.specPath),
                    });

                    // Sync ImportScanner when parseImports is null (oxc-main).
                    const children = syncScan
                        ? this.parseOneSync(info.specPath, info.localPath, fileKind)
                        : await this.parseOne(info.specPath, info.localPath, fileKind);
                    for (const child of children) enqueueEdge(child.spec, info.specPath);
                }
            } catch (e) {
                if (isParseWorkerError(e)) {
                    fatalWorkerError = e;
                    wake();
                    return;
                }
                prog?.bumpResolved();
                this.errs.push({ spec: item.spec, parent: item.parent, error: errMsg(e) });
            } finally {
                // Clear tracked row even on resolve-only (never downloaded) work.
                if (trackProgress) prog.finishDownload(item.spec);
                const age = Date.now() - startedMs;
                if (age >= 5000) {
                    log.debug('deps', () =>
                        `slow item ${age}ms (resolve=${resolvedMs}ms, scan=${Math.max(0, age - resolvedMs)}ms): ` +
                        `"${item.spec}" from "${item.parent}"`);
                }
                this.maybeLogStall(pending, queue.length - queueHead);
                pending--;
                // Wake only when pending===0; enqueue() already wakes new work.
                if (pending === 0) wake();
            }
        };

        const rootedWorker = async () => {
            while (true) {
                const item = await nextItem();
                if (!item) return;
                await processEdge(item);
                const yieldP = maybeYieldBatch();
                if (yieldP) await yieldP;
            }
        };

        // Full pool from the start; empty workers wait for newly enqueued imports.
        await Promise.all(Array.from({ length: CONCURRENCY }, () => rootedWorker()));
        prog?.setActivity(null);
        if (fatalWorkerError) throw fatalWorkerError;

        if (!this.cfg.silent && this.options.reportSummary !== false) {
            const e = this.errs.length ? `, ${this.errs.length} error(s)` : '';
            log.info(`✅ ${this.seen.size} modules${e}`);
        }
        return {
            visited: this.seen.size,
            downloaded: this.downloaded,
            errors: [...this.errs],
            modules: this.found,
            edges: [...this.edges],
            resolutions: [...this.resolutions],
        };
    }

    // Read + parse a single file, return its import specifiers

    private filterImports(
        specPath: string,
        imports: string[],
        fullGraph: boolean,
    ): Array<{ spec: string; parent: string }> {
        const out: Array<{ spec: string; parent: string }> = [];
        for (let i = 0; i < imports.length; i++) {
            const spec = imports[i];
            if (spec !== undefined && shouldEnqueueScannedImport(specPath, spec, fullGraph)) {
                out.push({ spec, parent: specPath });
            }
        }
        return out;
    }

    /** Resolve import list: lock cache (precache) or scan callback / ImportScanner. */
    private async loadImports(
        specPath: string,
        localPath: string,
        fileKind?: FileKind,
    ): Promise<string[] | null> {
        const fullGraph = this.options.fullGraph === true;
        // Warm precache may reuse lock imports; pack/fullGraph always rescans.
        if (!fullGraph) {
            const cached = this.resolver.lockStore.getImports(specPath);
            if (cached !== undefined) return cached;
        }
        let imports: string[];
        if (!isImportScannable(localPath, fileKind)) {
            return [];
        }
        if (this.parseImports) {
            imports = await this.parseImports(localPath);
        } else {
            const scanned = this.importScanner.scanFileResult(localPath, undefined, fullGraph);
            if (scanned === null) {
                if (fullGraph) throw new Error(`Could not read source for full dependency scan: ${localPath}`);
                return null;
            }
            imports = scanned;
        }
        if (!fullGraph) this.resolver.lockStore.setImports(specPath, imports);
        return imports;
    }

    /** Sync path when ImportScanner owns scan (no worker parseImports). */
    private parseOneSync(
        specPath: string,
        localPath: string,
        fileKind?: FileKind,
    ): Array<{ spec: string; parent: string }> {
        try {
            const fullGraph = this.options.fullGraph === true;
            let imports: string[] | undefined;
            if (!fullGraph) {
                const cached = this.resolver.lockStore.getImports(specPath);
                if (cached !== undefined) imports = cached;
            }
            if (imports === undefined) {
                if (!isImportScannable(localPath, fileKind)) return [];
                const scanned = this.importScanner.scanFileResult(localPath, undefined, fullGraph);
                if (scanned === null) {
                    if (fullGraph) throw new Error(`Could not read source for full dependency scan: ${localPath}`);
                    return [];
                }
                imports = scanned;
                if (!fullGraph) this.resolver.lockStore.setImports(specPath, imports);
            }
            return this.filterImports(specPath, imports, fullGraph);
        } catch (e) {
            if (this.options.fullGraph === true) throw e;
            return [];
        }
    }

    private async parseOne(
        specPath: string,
        localPath: string,
        fileKind?: FileKind,
    ): Promise<Array<{ spec: string; parent: string }>> {
        try {
            const imports = await this.loadImports(specPath, localPath, fileKind);
            if (imports === null) return [];
            return this.filterImports(specPath, imports, this.options.fullGraph === true);
        } catch (e) {
            // Worker scanner reports real file errors; infrastructure aborts the scan.
            if (this.options.fullGraph === true || this.parseImports || isParseWorkerError(e)) throw e;
            return [];
        }
    }

    /** DEBUG: if work stays in-flight a long time, log once per 10s (not a kill). */
    private maybeLogStall(pending: number, queued: number): void {
        const now = Date.now();
        if (now - this.lastStallLogMs < 10_000) return;
        if (pending <= 0) return;
        this.lastStallLogMs = now;
        log.debug('deps', () => `in-flight pending=${pending} queued=${queued} visited=${this.seen.size}`);
    }
}
