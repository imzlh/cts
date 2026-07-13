import type { RuntimeConfig, ModuleFormat } from './types';
import { ModuleResolver } from './resolve/index';
import { errMsg, log, getMemoryTier, PrecacheProgress, npmPackageName, isRelative } from './utils';
import { isRemote } from './source/cache';
import type { OxcTranspiler } from './oxc';
import { ImportScanner } from './import-scanner';
import { isScannablePath, isWasmPath } from './scan';

const os = import.meta.use('os');
const { setTimeout } = import.meta.use('timers');

/** Yield so libuv timers (progress UI) can run during long sync parse stretches. */
function yieldEventLoop(): Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, 0); });
}

// Parallel BFS — full scan, no lock deps shortcut

export interface ScanResult {
    visited: number;
    downloaded: number;
    errors: Array<{ spec: string; parent: string; error: string }>;
    modules: Array<{ specPath: string; localPath: string; format: ModuleFormat; remote: boolean }>;
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

                    // Always record edge (per-parent node_modules link). Use resolved npm: path.
                    if (info.specPath.startsWith('npm:') && isEligibleParent(item.parent)) {
                        const name = npmPackageName(info.specPath);
                        const parentName = item.parent.startsWith('npm:') ? npmPackageName(item.parent) : null;
                        // Skip self-deps (pkg → pkg/...) — soft mode would self-link forever.
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
                        // Sync parse of large graphs starves the progress timer;
                        // yield so UI (and other timers) can paint.
                        if ((this.seen.size & 31) === 0) await yieldEventLoop();
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
                    // Wake only when pending===0; otherwise idle workers busy-loop.
                    if (pending === 0) wake();
                }
            }
        };

        // Full pool from the start; empty workers wait for newly enqueued imports.
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

    // Read + parse a single file, return its import specifiers

    private async parseOne(
        specPath: string,
        localPath: string,
    ): Promise<Array<{ spec: string; parent: string }>> {
        try {
            // All file kinds via ImportScanner — do not special-case wasm here.
            let imports: string[];
            if (this.parseImports) {
                imports = await this.parseImports(localPath);
            } else if (isWasmPath(localPath) || isScannablePath(localPath)) {
                imports = this.importScanner.scanFile(localPath);
            } else {
                return [];
            }
            const out: Array<{ spec: string; parent: string }> = [];
            const fullGraph = this.options.fullGraph === true;
            for (let i = 0; i < imports.length; i++) {
                const spec = imports[i];
                if (spec !== undefined && shouldEnqueueScannedImport(specPath, spec, fullGraph)) {
                    out.push({ spec, parent: specPath });
                }
            }
            return out;
        } catch {
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
