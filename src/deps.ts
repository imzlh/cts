import type { RuntimeConfig, ModuleFormat } from './types';
import { ModuleResolver } from './resolve/index';
import { errMsg, log, getMemoryTier, PrecacheProgress, npmPackageName, isRelative } from './utils';
import { isRemote } from './source/cache';
import type { OxcTranspiler } from './oxc';
import { ImportScanner } from './import-scanner';
import { isScannablePath, isWasmPath } from './scan';

const asyncfs = import.meta.use('asyncfs');
const wasm = import.meta.use('wasm');
const os = import.meta.use('os');

function isWasiModuleName(name: string): boolean {
    return name === 'wasi_unstable' || name === 'wasi_snapshot_preview1';
}

// ---------------------------------------------------------------------------
// Parallel BFS — full scan, no lock deps shortcut
// ---------------------------------------------------------------------------

export interface ScanResult {
    visited: number;
    downloaded: number;
    errors: Array<{ spec: string; parent: string; error: string }>;
    modules: Array<{ specPath: string; localPath: string; format: ModuleFormat; remote: boolean }>;
    // Parent -> resolved-child edges, used to materialize a real node_modules
    // tree (node_modules mode). Only npm: children with an eligible parent
    // (an npm: package, or a synthetic project-root scan seed) are recorded —
    // see isEligibleParent().
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

    /**
     * BFS from an explicit set of specifiers (no entry file needed).
     */
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

    /**
     * BFS from the entry file's import graph *and* an explicit specifier set
     * in one pass. Used by `cno cache <entry>` to also pull in package.json
     * devDependencies (e.g. dev-tool bins) that aren't reachable from the
     * entry's static imports but that `cno task` will need to resolve later.
     */
    async scanEntryAndSpecifiers(entrySpecPath: string, entryLocalPath: string, specifiers: string[], parentDir: string): Promise<ScanResult> {
        this.init();
        const seeds: Array<{ spec: string; parent: string }> = [
            { spec: entrySpecPath, parent: `${os.cwd}/<entry>` },
        ];
        const parent = `${parentDir}/<cache>`;
        for (const spec of specifiers) seeds.push({ spec, parent });
        return this.queueLoopInternal(seeds);
    }

    // -------------------------------------------------------------------------
    // Shared internals
    // -------------------------------------------------------------------------

    private init(): void {
        this.seen.clear();
        this.errs.length = 0;
        this.found.length = 0;
        this.edges.length = 0;
        this.resolutions.length = 0;
        this.downloaded = 0;
    }

    /**
     * Concurrent queue: keep the full curl connection pool busy.
     * Each worker pulls one specifier, resolves it, enqueues its children.
     * No waiting for a whole batch to finish.
     */
    private async queueLoopInternal(
        seeds: Array<{ spec: string; parent: string }>,
    ): Promise<ScanResult> {
        // Queue holds specifiers to resolve (spec, parentSpecPath)
        const queue: Array<{ spec: string; parent: string }> = [];
        // pending counts items not yet fully processed (queued + active).
        let pending = 0;
        const wakeWaiters: Array<() => void> = [];

        const wake = () => {
            const waiters = wakeWaiters.splice(0);
            for (const fn of waiters) fn();
        };

        const enqueue = (spec: string, parent: string) => {
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

        const CONCURRENCY = { low: 4, normal: 8, high: 16 }[getMemoryTier()] ?? 8;
        const nextItem = async (): Promise<{ spec: string; parent: string } | null> => {
            while (queue.length === 0) {
                if (pending === 0) return null;
                await new Promise<void>(resolve => { wakeWaiters.push(resolve); });
            }
            return queue.shift() ?? null;
        };

        const rootedWorker = async () => {
            while (true) {
                const item = await nextItem();
                if (!item) return;

                let didDownload = false;
                const baseProgress = this.prog?.onDownloadProgress(item.spec);
                const onProgress = baseProgress
                    ? (now: number, total: number) => { didDownload = true; baseProgress(now, total); }
                    : undefined;
                const startedMs = Date.now();
                this.prog?.startResolve(item.spec);

                try {
                    const info = await this.resolver.resolveAsync(item.spec, item.parent, undefined, onProgress);
                    if (didDownload) this.downloaded++;
                    this.prog?.bumpResolved();
                    if (this.options.fullGraph === true) {
                        this.resolutions.push({
                            parentSpecPath: item.parent,
                            specifier: item.spec,
                            childSpecPath: info.specPath,
                        });
                    }
                    if (this.options.excludeSpecPath?.(info.specPath) === true) continue;

                    // Record the parent -> resolved-child edge unconditionally
                    // (even if this child was already visited via a different
                    // parent) — each parent needs its own node_modules/<name>
                    // link, even though the child itself is only downloaded
                    // and scanned once. Gate on the *resolved* specPath being
                    // npm: (info.specPath, not the raw request item.spec,
                    // which may be a range/alias/bare-name) and on the parent
                    // being eligible (an npm: package or a synthetic
                    // project-root scan seed).
                    if (info.specPath.startsWith('npm:') && isEligibleParent(item.parent)) {
                        const name = npmPackageName(info.specPath);
                        const parentName = item.parent.startsWith('npm:') ? npmPackageName(item.parent) : null;
                        // Skip package self-references like `axios` importing
                        // `axios/...` from within axios itself. Materializing
                        // those into `<pkg>/node_modules/<pkg>` causes an
                        // infinite self-link chain in soft mode.
                        if (name && name !== parentName) {
                            this.edges.push({ parentSpecPath: item.parent, name, childSpecPath: info.specPath, childLocalPath: info.localPath });
                        }
                    }

                    if (!this.seen.has(info.specPath)) {
                        this.seen.add(info.specPath);
                        this.found.push({ specPath: info.specPath, localPath: info.localPath, format: info.format, remote: isRemote(info.specPath) });

                        // parseOne self-gates on extension and tolerates a missing
                        // file (readFile failure → []), so no extra fs.exists stat.
                        const children = await this.parseOne(info.specPath, info.localPath);
                        for (const child of children) enqueue(child.spec, info.specPath);
                    }
                } catch (e) {
                    this.prog?.bumpResolved();
                    this.errs.push({ spec: item.spec, parent: item.parent, error: errMsg(e) });
                } finally {
                    // Always clear progress — resolve-only work never called
                    // finishDownload and left the spinner stuck on one label.
                    this.prog?.finishDownload(item.spec);
                    const age = Date.now() - startedMs;
                    if (age >= 5000) {
                        log.debug('deps', () => `slow item ${age}ms: "${item.spec}" from "${item.parent}"`);
                    }
                    this.maybeLogStall(pending, queue.length);
                    pending--;
                    // Only wake waiters when all work is done (pending hits 0) so
                    // they can exit. While in-flight resolves are still pending,
                    // idle workers should keep sleeping — re-checking queue state
                    // every time another resolve finishes just burns CPU in a
                    // busy-loop without making progress.
                    if (pending === 0) wake();
                }
            }
        };

        // Start the full worker pool. The initial queue is often just the
        // entry module; workers that find an empty queue will wait for imports
        // discovered by the active worker instead of making the scan serial.
        await Promise.all(Array.from({ length: CONCURRENCY }, () => rootedWorker()));

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

    // -------------------------------------------------------------------------
    // Read + parse a single file, return its import specifiers
    // -------------------------------------------------------------------------

    private async parseOne(
        specPath: string,
        localPath: string,
    ): Promise<Array<{ spec: string; parent: string }>> {
        if (isWasmPath(localPath)) {
            if (!wasm) return [];
            try {
                const bytes = await asyncfs.readFile(localPath);
                const wmod = wasm.parseModule(new Uint8Array(bytes));
                const seen = new Set<string>();
                for (const imp of wasm.moduleImports(wmod)) {
                    if (isWasiModuleName(imp.module)) continue;
                    if (imp.module === 'env') continue;
                    if (seen.has(imp.module)) continue;
                    seen.add(imp.module);
                }
                const imports: Array<{ spec: string; parent: string }> = [];
                for (const spec of seen) imports.push({ spec, parent: specPath });
                return imports;
            } catch (e) {
                log.debug('deps', () => `wasm scan failed for ${localPath}: ${errMsg(e)}`);
                return [];
            }
        }
        if (!isScannablePath(localPath) && !this.parseImports) return [];
        try {
            // Prefer caller-supplied scanner (pack records edges); else main-thread
            // ImportScanner (oxc-first). Never route scan through transform workers.
            const imports = this.parseImports
                ? await this.parseImports(localPath)
                : this.importScanner.scanFile(localPath);
            const out: Array<{ spec: string; parent: string }> = [];
            for (let i = 0; i < imports.length; i++) {
                const spec = imports[i];
                if (spec !== undefined && shouldEnqueueScannedImport(specPath, spec, this.options.fullGraph === true)) {
                    out.push({ spec, parent: specPath });
                }
            }
            return out;
        } catch { return []; }
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
