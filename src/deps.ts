import type { RuntimeConfig } from './types';
import { ModuleResolver } from './resolver';
import { extname } from './utils/path';
import { errMsg } from './utils/misc';
import { log } from './utils/log';
import { PrecacheProgress } from './utils/progress';
import type { OxcTranspiler } from './oxc';
import { extractImports, SCANNABLE, WASM_EXT } from './scan';
import { getMemoryTier } from './utils/tier';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const asyncfs = import.meta.use('asyncfs');
const wasm = import.meta.use('wasm');
const os = import.meta.use('os');

// WASI module names — provided by the runtime, no JS resolution needed.
const WASI_MODS = new Set(['wasi_unstable', 'wasi_snapshot_preview1']);

async function extractImportsFast(
    source: string,
    filename: string,
    isTs: boolean,
    acc: OxcTranspiler | null,
): Promise<string[]> {
    if (!source.includes('import') && !source.includes('export') && !source.includes('require')) return [];
    if (acc) {
        try {
            const deps = acc.scanImports(source, filename);
            if (deps !== null) return deps;
        } catch (e) {
            log.debug('oxc', () => `scanImports failed for ${filename}: ${errMsg(e)}`);
        }
    }
    return extractImports(source, isTs);
}

// ---------------------------------------------------------------------------
// Parallel BFS — full scan, no lock deps shortcut
// ---------------------------------------------------------------------------

export interface ScanResult {
    visited: number;
    downloaded: number;
    errors: Array<{ spec: string; parent: string; error: string }>;
    modules: Array<{ specPath: string; localPath: string }>;
}

export class DepScanner {
    private readonly seen = new Set<string>();
    private readonly errs: ScanResult['errors'] = [];
    private readonly found: ScanResult['modules'] = [];
    private downloaded = 0;

    constructor(
        private readonly resolver: ModuleResolver,
        private readonly cfg: RuntimeConfig,
        private readonly prog: PrecacheProgress | null = null,
        private readonly oxc: OxcTranspiler | null = null,
        private readonly scanWorker: ((source: string, localPath: string) => Promise<string[]>) | null = null,
    ) { }

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
            return { visited: 0, downloaded: 0, errors: [], modules: [] };
        }
        const parent = `${parentDir}/<cache>`;
        const seeds: Array<{ spec: string; parent: string }> = [];
        for (const spec of specifiers) {
            seeds.push({ spec, parent });
        }
        return this.queueLoopInternal(seeds);
    }

    // -------------------------------------------------------------------------
    // Shared internals
    // -------------------------------------------------------------------------

    private init(): void {
        this.seen.clear();
        this.errs.length = 0;
        this.found.length = 0;
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
            while (wakeWaiters.length) wakeWaiters.shift()!();
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
            return { visited: 0, downloaded: 0, errors: [], modules: [] };
        }

        const CONCURRENCY = { low: 4, normal: 8, high: 16 }[getMemoryTier()] ?? 8;
        const nextItem = async (): Promise<{ spec: string; parent: string } | null> => {
            while (queue.length === 0) {
                if (pending === 0) return null;
                await new Promise<void>(resolve => { wakeWaiters.push(resolve); });
            }
            return queue.shift()!;
        };
        let active = 0;
        let settled = false;   // prevents double-resolve
        let doneResolve: (() => void) | null = null;
        const tryDone = () => {
            if (pending === 0 && doneResolve && !settled) {
                settled = true;
                // Defer the Promise settlement to the next microtask.
                // Calling doneResolve() synchronously here resolves the outer
                // queueLoopInternal Promise while worker frames are still running,
                // which causes QuickJS to decrement the async-closure refcount
                // prematurely and free the shared closure env (queue, this, etc.)
                // before the worker's finally block finishes.
                const resolve = doneResolve;
                doneResolve = null;
                Promise.resolve().then(resolve);
            }
        };

        const worker = async () => {
            if (active >= CONCURRENCY) return;
            active++;
            try {
                while (queue.length > 0) {
                    const item = queue.shift()!;
                    let didDownload = false;
                    const baseProgress = this.prog?.onDownloadProgress(item.spec);
                    const onProgress = baseProgress
                        ? (now: number, total: number) => { didDownload = true; baseProgress(now, total); }
                        : undefined;

                    try {
                        this.prog?.startResolve(item.spec);
                        const info = await this.resolver.resolveAsync(item.spec, item.parent, undefined, onProgress);
                        if (didDownload) this.downloaded++;
                        this.prog?.bumpResolved();
                        this.prog?.finishDownload(item.spec);

                        if (this.seen.has(info.specPath)) { pending--; tryDone(); continue; }
                        this.seen.add(info.specPath);
                        this.found.push({ specPath: info.specPath, localPath: info.localPath });

                        // Enqueue child imports for next-level processing
                        if (fs.exists(info.localPath) && (SCANNABLE.has(extname(info.localPath)) || extname(info.localPath) === WASM_EXT)) {
                            const children = await this.parseOne(info.specPath, info.localPath);
                            for (const child of children) {
                                enqueue(child.spec, info.specPath);
                            }
                        }
                    } catch (e) {
                        this.prog?.bumpResolved();
                        this.prog?.finishDownload(item.spec, errMsg(e));
                        this.errs.push({ spec: item.spec, parent: item.parent, error: errMsg(e) });
                        // Continue scanning — don't let one module failure stop the whole BFS
                    }
                    pending--;
                    tryDone();
                }
            } finally {
                active--;
                // If queue still has items and we have capacity, start another worker.
                // This is critical: if active workers dropped to 0 while new items
                // were enqueued (e.g. by a different worker between our shift and now),
                // the scan would stall without this kick.
                if (queue.length > 0 && active < CONCURRENCY) worker();
            }
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

                try {
                    this.prog?.startResolve(item.spec);
                    const info = await this.resolver.resolveAsync(item.spec, item.parent, undefined, onProgress);
                    if (didDownload) this.downloaded++;
                    this.prog?.bumpResolved();
                    this.prog?.finishDownload(item.spec);

                    if (!this.seen.has(info.specPath)) {
                        this.seen.add(info.specPath);
                        this.found.push({ specPath: info.specPath, localPath: info.localPath });

                        if (fs.exists(info.localPath) && (SCANNABLE.has(extname(info.localPath)) || extname(info.localPath) === WASM_EXT)) {
                            const children = await this.parseOne(info.specPath, info.localPath);
                            for (const child of children) enqueue(child.spec, info.specPath);
                        }
                    }
                } catch (e) {
                    this.prog?.bumpResolved();
                    this.prog?.finishDownload(item.spec, errMsg(e));
                    this.errs.push({ spec: item.spec, parent: item.parent, error: errMsg(e) });
                } finally {
                    pending--;
                    wake();
                }
            }
        };

        // Start the full worker pool. The initial queue is often just the
        // entry module; workers that find an empty queue will wait for imports
        // discovered by the active worker instead of making the scan serial.
        await Promise.all(Array.from({ length: CONCURRENCY }, () => rootedWorker()));

        if (!this.cfg.silent) {
            const e = this.errs.length ? `, ${this.errs.length} error(s)` : '';
            log.info(`✅ ${this.seen.size} modules${e}`);
        }
        return { visited: this.seen.size, downloaded: this.downloaded, errors: [...this.errs], modules: this.found };
    }

    // -------------------------------------------------------------------------
    // Read + parse a single file, return its import specifiers
    // -------------------------------------------------------------------------

    private async parseOne(
        specPath: string,
        localPath: string,
    ): Promise<Array<{ spec: string; parent: string }>> {
        const ext = extname(localPath);
        if (ext === WASM_EXT) {
            if (!wasm) return [];
            try {
                const bytes = await asyncfs.readFile(localPath);
                const wmod = wasm.parseModule(new Uint8Array(bytes));
                const seen = new Set<string>();
                for (const imp of wasm.moduleImports(wmod)) {
                    if (WASI_MODS.has(imp.module)) continue;
                    if (imp.module === 'env') continue;
                    if (seen.has(imp.module)) continue;
                    seen.add(imp.module);
                }
                return [...seen].map(spec => ({ spec, parent: specPath }));
            } catch (e) {
                log.debug('deps', () => `wasm scan failed for ${localPath}: ${errMsg(e)}`);
                return [];
            }
        }
        if (!SCANNABLE.has(ext)) return [];
        try {
            const bytes = await asyncfs.readFile(localPath);
            const src = engine.decodeString(bytes);
            let imports: string[];
            if (this.scanWorker) {
                imports = await this.scanWorker(src, localPath);
            } else {
                const isTs = /\.[mc]?tsx?$/.test(localPath);
                imports = await extractImportsFast(src, localPath, isTs, this.cfg.enableOxc !== false ? this.oxc : null);
            }
            return imports.map(spec => ({ spec, parent: specPath }));
        } catch { return []; }
    }
}
