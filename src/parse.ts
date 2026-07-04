// parse.ts — Worker-parallel scan/transform + main-thread QJS compile
//
// ParseDriver owns the source-processing pipeline for precache:
// 1. scanFile() drives dependency discovery during BFS
// 2. compileModules() transforms source and emits QJS bytecode
//
// Both phases share one worker pool so scan and transform run under the same
// lifetime/timeout/error-handling policy instead of being split across layers.

import { Transformer } from './source/transform';
import { OxcTranspiler, oxcExtPath, type OxcModule } from './oxc';
import { extractImports } from './scan';
import { readText, errMsg, log, getMemoryTier, type MemoryTier } from './utils';

const { setTimeout, clearTimeout } = import.meta.use('timers');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const worker = import.meta.use('worker');
const smap = import.meta.use('sourcemap');

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

interface WorkerTask {
    id: number;
    kind: 'transform' | 'scan';
    localPath: string;
    specPath?: string; // transform only: the module's runtime identity (see Transformer.transform's mapKey)
    source?: string;   // scan: provided; transform: read lazily at dispatch
}

interface WorkerResult {
    id: number;
    kind: 'transform' | 'scan';
    localPath: string;
    code?: string;    // transform
    sourceMap?: string | object; // transform: relayed for the main thread to register (see onWorkerResult)
    deps?: string[];  // scan
    error?: string;
}

interface WorkerPolicy {
    maxWorkers: number;
    source: string;
}

function availableParallelism(): number {
    try {
        const n = Number(os.availableParallelism ? os.availableParallelism() : 1);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
    } catch {
        return 1;
    }
}

function workersForTier(tier: MemoryTier): number {
    if (tier === 'low') return 0;
    if (tier === 'normal') return 2;
    return availableParallelism();
}

function parseWorkerOverride(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.floor(n));
}

function resolveWorkerPolicy(): WorkerPolicy {
    let raw: string | null = null;
    try { raw = os.getenv('CTS_WORKERS') ?? null; } catch {}
    const overridden = parseWorkerOverride(raw);
    if (overridden !== null) {
        return { maxWorkers: overridden, source: `CTS_WORKERS=${raw}` };
    }

    const tier = getMemoryTier();
    return { maxWorkers: workersForTier(tier), source: `memory-tier=${tier}` };
}

function hasImportSyntax(source: string): boolean {
    return source.includes('import') || source.includes('export') || source.includes('require');
}

// ---------------------------------------------------------------------------
// In-worker: load oxc + sucrase fallback, handle both task kinds
// ---------------------------------------------------------------------------

export function isParseWorker(): boolean {
    const role = (worker.workerData as any)?.__cts_role;
    return worker.isWorker && (role === 'parse' || role === 'compiler');
}

export async function runParseWorker(): Promise<void> {
    const pipe = worker.pipe!;
    const wd = worker.workerData as any;
    // Sourcemaps are captured and relayed to the main thread instead of
    // registered here — this worker's JSContext is not where compiled
    // modules run, so a local smap.load() would be invisible to stack traces.
    const transformer = new Transformer({ sourceMaps: true });
    let oxcTranspiler: OxcTranspiler | null = null;

    const extPath: string | null = wd?.__oxc_path ?? null;
    if (extPath) {
        try {
            import.meta.register('oxc', extPath);
            const oxcMod = (import.meta.use as any)('oxc') as OxcModule;
            if (typeof oxcMod?.transpile === 'function') {
                oxcTranspiler = new OxcTranspiler(oxcMod);
                transformer.setOxc(oxcTranspiler);
                log.debug('precompile', () => `worker: oxc loaded from ${extPath}`);
            } else {
                log.debug('precompile', () => `worker: oxc module API unexpected`);
            }
        } catch (e) {
            log.debug('precompile', () => `worker: oxc unavailable: ${errMsg(e)}`);
        }
    }

    pipe.onmessage = (raw: any) => {
        const task = raw as WorkerTask;
        if (task?.id === undefined) return;
        const source = task.source ?? '';

        if (task.kind === 'scan') {
            try {
                if (!hasImportSyntax(source)) {
                    pipe.postMessage({ id: task.id, kind: 'scan', localPath: task.localPath, deps: [] } as WorkerResult);
                    return;
                }
                let deps: string[] | null = null;
                if (oxcTranspiler) {
                    try { deps = oxcTranspiler.scanImports(source, task.localPath); } catch {}
                }
                if (deps === null) {
                    const isTs = /\.[mc]?tsx?$/.test(task.localPath);
                    deps = extractImports(source, isTs);
                }
                pipe.postMessage({ id: task.id, kind: 'scan', localPath: task.localPath, deps } as WorkerResult);
            } catch (e) {
                pipe.postMessage({ id: task.id, kind: 'scan', localPath: task.localPath, deps: [], error: errMsg(e) } as WorkerResult);
            }
            return;
        }

        try {
            const { code, sourceMap } = transformer.transformCapture(source, task.localPath, undefined, task.specPath);
            pipe.postMessage({ id: task.id, kind: 'transform', localPath: task.localPath, code, sourceMap } as WorkerResult);
        } catch (e) {
            pipe.postMessage({ id: task.id, kind: 'transform', localPath: task.localPath, error: errMsg(e) } as WorkerResult);
        }
    };
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

class TxWorker {
    readonly w: CModuleWorker.Worker;
    readonly pipe: CModuleWorker.MessagePipe;
    busy = false;
    idx: number;

    constructor(
        idx: number,
        oxcPath: string | null,
        onResult: (r: WorkerResult) => void,
        onError: (workerIdx: number, error: unknown) => void,
    ) {
        this.idx = idx;
        this.w = new worker.Worker({ __cts_role: 'parse', __oxc_path: oxcPath });
        this.pipe = this.w.messagePipe;
        this.pipe.onmessage = (data: any) => {
            this.busy = false;
            onResult(data as WorkerResult);
        };
        this.pipe.onmessageerror = (error: unknown) => {
            this.busy = false;
            onError(this.idx, error);
        };
    }

    send(task: WorkerTask): void {
        this.busy = true;
        this.pipe.postMessage(task);
    }

    detach(): void {
        this.pipe.onmessage = undefined;
        this.pipe.onmessageerror = undefined;
    }

    async terminate(): Promise<void> {
        this.detach();
        await this.w.terminate();
    }
}

// ---------------------------------------------------------------------------
// ParseDriver
// ---------------------------------------------------------------------------

export class ParseDriver {
    private workers: TxWorker[] = [];
    /** Transform batch tasks — dispatched after scan tasks */
    private pending: WorkerTask[] = [];
    /** Scan tasks — dispatched first (lightweight, unblock BFS) */
    private scanQueue: WorkerTask[] = [];
    private scanCallbacks = new Map<number, (deps: string[]) => void>();
    /** id → specPath for in-flight transform tasks (compiled+freed on arrival) */
    private specMap = new Map<number, string>();
    /** localPath → bytecode, the only thing kept; sources/code are freed per task */
    private bytecodes = new Map<string, ArrayBuffer>();
    /** optional sink: when set, compiled bytecode is consumed and not retained */
    private onCompiled?: (localPath: string, bc: ArrayBuffer) => void;
    private nextId = 0;
    private maxWorkers: number;
    private oxcPath: string | null;
    private oxc: OxcTranspiler | null;
    private inlineTransformer: Transformer | null = null;
    private taskTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private workerTaskId = new Map<number, number>(); // worker.idx → current task id
    private taskInfo = new Map<number, { kind: WorkerTask['kind']; localPath: string; workerIdx: number }>();
    private scanFallbacks = new Map<number, { source: string; localPath: string }>();
    private deadWorkers = new Set<number>();
    private settled = false;
    private closing = false;
    private transformDone = 0;
    private transformFail = 0;
    private taskTotal = 0;
    private resolveTransforms?: () => void;
    private onProgressCb?: (done: number, total: number) => void;

    private static readonly TRANSFORM_TASK_TIMEOUT_MS = 60_000;
    private static readonly GLOBAL_TIMEOUT_MS = 1200_000;
    private globalTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(oxc: OxcTranspiler | null = null) {
        this.oxc = oxc;
        this.oxcPath = oxc ? oxcExtPath() : null;
        const policy = resolveWorkerPolicy();
        this.maxWorkers = policy.maxWorkers;
        log.debug('precompile', () => `oxc path: ${this.oxcPath ?? 'not found'}`);
        log.debug('precompile', () => `worker policy: ${this.maxWorkers === 0 ? 'inline' : `${this.maxWorkers} workers`} (${policy.source})`);
    }

    /** Lazily grow the worker pool to match queued/in-flight work. */
    private ensureWorkers(): void {
        if (this.maxWorkers <= 0 || this.closing) return;
        const active = this.workerTaskId.size;
        const queued = this.scanQueue.length + this.pending.length;
        const desired = Math.min(this.maxWorkers, active + queued);
        let live = this.workers.length - this.deadWorkers.size;
        while (live < desired) {
            const w = new TxWorker(
                this.workers.length,
                this.oxcPath,
                (r) => this.onWorkerResult(r),
                (workerIdx, error) => this.onWorkerError(workerIdx, error),
            );
            this.workers.push(w);
            live++;
            log.debug('precompile', () => `spawned worker ${w.idx}`);
        }
    }

    /**
     * Scan a source file for import specifiers using the worker pool.
     * Workers handle OXC (if available) with Sucrase fallback.
     * Can be called concurrently during BFS before compileModules() is invoked.
     */
    async scanFile(source: string, localPath: string): Promise<string[]> {
        if (this.closing) return [];
        if (this.maxWorkers <= 0) return this.scanInline(source, localPath);
        this.ensureWorkers();
        const id = this.nextId++;
        const task: WorkerTask = { id, kind: 'scan', localPath, source };
        return new Promise<string[]>(resolve => {
            this.scanFallbacks.set(id, { source, localPath });
            this.scanQueue.push(task);
            const wrappedResolve = (deps: string[]) => {
                this.scanFallbacks.delete(id);
                resolve(deps);
            };
            this.scanCallbacks.set(id, wrappedResolve);
            this.drain();
        });
    }

    async compileModules(
        modules: Array<{ specPath: string; localPath: string }>,
        onProgress?: (done: number, total: number) => void,
        onCompiled?: (localPath: string, bc: ArrayBuffer) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        if (this.closing) return new Map();
        if (!modules.length) return new Map();
        if (this.maxWorkers <= 0) {
            return this.compileModulesInline(modules, onProgress, onCompiled);
        }

        this.onCompiled = onCompiled;
        this.bytecodes = new Map<string, ArrayBuffer>();

        log.debug('precompile', () => `queuing ${modules.length} modules`);

        // Tasks carry no source — it is read lazily at dispatch (and freed at
        // result) so we never hold the whole graph's sources at once.
        const tasks: WorkerTask[] = [];
        for (const m of modules) {
            const id = this.nextId++;
            tasks.push({ id, kind: 'transform', localPath: m.localPath, specPath: m.specPath });
            this.specMap.set(id, m.specPath);
        }

        if (!tasks.length) return this.bytecodes;

        this.taskTotal = tasks.length;
        this.transformDone = 0;
        this.transformFail = 0;
        this.settled = false;
        this.onProgressCb = onProgress;

        const allTransformsDone = new Promise<void>(resolve => {
            this.resolveTransforms = resolve;
        });

        this.ensureWorkers();

        this.pending = tasks;
        this.drain();

        this.globalTimer = setTimeout(() => this.finish(), ParseDriver.GLOBAL_TIMEOUT_MS);

        await allTransformsDone;

        log.debug('precompile', () => `transforms: ${this.transformDone} ok, ${this.transformFail} fail`);
        log.debug('precompile', () => `compiled ${this.bytecodes.size}/${tasks.length} (${this.workers.length} workers)`);

        const out = this.bytecodes;
        this.bytecodes = new Map();
        this.specMap.clear();
        this.pending.length = 0;
        this.onCompiled = undefined;
        return out;
    }

    private scanInline(source: string, localPath: string): string[] {
        try {
            if (!hasImportSyntax(source)) return [];
            if (this.oxc) {
                const deps = this.oxc.scanImports(source, localPath);
                if (deps !== null) return deps;
            }
            const isTs = /\.[mc]?tsx?$/.test(localPath);
            return extractImports(source, isTs);
        } catch (e) {
            log.debug('precompile', () => `inline scan fail: ${localPath}: ${errMsg(e)}`);
            return [];
        }
    }

    private getInlineTransformer(): Transformer {
        if (!this.inlineTransformer) {
            const transformer = new Transformer({ sourceMaps: true });
            if (this.oxc) transformer.setOxc(this.oxc);
            this.inlineTransformer = transformer;
        }
        return this.inlineTransformer;
    }

    async precompile(
        modules: Array<{ specPath: string; localPath: string }>,
        onProgress?: (done: number, total: number) => void,
        onCompiled?: (localPath: string, bc: ArrayBuffer) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        return this.compileModules(modules, onProgress, onCompiled);
    }

    private async compileModulesInline(
        modules: Array<{ specPath: string; localPath: string }>,
        onProgress?: (done: number, total: number) => void,
        onCompiled?: (localPath: string, bc: ArrayBuffer) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        const bytecodes = new Map<string, ArrayBuffer>();
        let done = 0;
        let fail = 0;
        const total = modules.length;
        const transformer = this.getInlineTransformer();

        log.debug('precompile', () => `inline precompile begin: ${total} modules`);
        for (const m of modules) {
            try {
                const source = readText(m.localPath);
                const code = transformer.transform(source, m.localPath, undefined, m.specPath);
                const mod = new engine.Module(code, m.specPath);
                const bc = mod.dump();
                if (onCompiled) onCompiled(m.localPath, bc);
                else bytecodes.set(m.localPath, bc);
                done++;
            } catch (e) {
                fail++;
                log.debug('precompile', () => `inline compile fail: ${m.localPath}: ${errMsg(e)}`);
            }
            onProgress?.(done + fail, total);
        }

        log.debug('precompile', () => `inline transforms: ${done} ok, ${fail} fail`);
        return bytecodes;
    }

    private onWorkerResult(r: WorkerResult): void {
        const task = this.takeTask(r.id);
        if (!task) {
            log.debug('precompile', () => `late result discarded: ${r.localPath}`);
            return;
        }

        if (r.kind === 'scan') {
            const cb = this.scanCallbacks.get(r.id);
            if (cb) {
                this.scanCallbacks.delete(r.id);
                cb(r.deps ?? []);
            }
            this.drain();
            return;
        }

        // Transform result: compile to bytecode now and free the code string so
        // we never retain every transpiled source at once (peak RSS bound).
        const specPath = this.specMap.get(r.id);
        if (specPath) this.specMap.delete(r.id);
        if (r.code && specPath) {
            try {
                // Register under specPath — the identity the compiled Module()
                // below actually runs as, not the worker's r.localPath.
                if (r.sourceMap) {
                    try {
                        if (typeof r.sourceMap === 'string') smap.loadJSON(specPath, r.sourceMap);
                        else smap.load(specPath, r.sourceMap);
                    } catch (e) { log.debug('precompile', () => `smap relay: ${r.localPath}: ${errMsg(e)}`); }
                }
                const mod = new engine.Module(r.code, specPath);
                const bc = mod.dump();
                // Sink consumes + drops it (precache → disk); else accumulate.
                if (this.onCompiled) this.onCompiled(r.localPath, bc);
                else this.bytecodes.set(r.localPath, bc);
            } catch (e) {
                log.debug('precompile', () => `compile fail: ${r.localPath}: ${errMsg(e)}`);
            }
            this.transformDone++;
        } else {
            this.transformFail++;
            log.debug('precompile', () => `transform fail: ${r.localPath}: ${r.error}`);
        }
        r.code = undefined;
        r.sourceMap = undefined;
        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
        this.drain();
        if (this.transformDone + this.transformFail >= this.taskTotal) this.finish();
    }

    private onWorkerError(workerIdx: number, error: unknown): void {
        const taskId = this.workerTaskId.get(workerIdx);
        const suffix = taskId !== undefined ? ` while handling task ${taskId}` : '';
        log.debug('precompile', () => `worker ${workerIdx} message error${suffix}: ${errMsg(error)}`);
        this.deadWorkers.add(workerIdx);
        if (taskId === undefined) return;
        this.failTask(taskId, `worker ${workerIdx} message error: ${errMsg(error)}`, true);
    }

    private onTaskTimeout(taskId: number): void {
        const task = this.takeTask(taskId);
        if (!task) return;
        this.deadWorkers.add(task.workerIdx);

        if (task.kind === 'scan') {
            const deps = this.resolveScanFallback(taskId, 'scan timeout');
            const cb = this.scanCallbacks.get(taskId);
            if (cb) { this.scanCallbacks.delete(taskId); cb(deps); }
        } else {
            this.specMap.delete(taskId);
            this.transformFail++;
            log.debug('precompile', () => `transform timeout (${ParseDriver.TRANSFORM_TASK_TIMEOUT_MS}ms): ${task.localPath} (worker ${task.workerIdx} dead)`);
        }

        this.drain();

        if (this.deadWorkers.size >= this.workers.length) {
            // All workers dead — abandon remaining queued tasks
            while (this.scanQueue.length > 0) {
                const t = this.scanQueue.shift()!;
                const deps = this.resolveScanFallback(t.id, 'all workers dead');
                const cb = this.scanCallbacks.get(t.id);
                if (cb) { this.scanCallbacks.delete(t.id); cb(deps); }
            }
            if (this.pending.length > 0) {
                log.debug('precompile', () => `all workers dead, abandoning ${this.pending.length} transform tasks`);
                while (this.pending.length > 0) {
                    const t = this.pending.shift()!;
                    this.transformFail++;
                    log.debug('precompile', () => `abandoned: ${t.localPath}`);
                }
            }
        }

        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
        if (this.taskTotal > 0 && this.transformDone + this.transformFail >= this.taskTotal) this.finish();
    }

    private finish(): void {
        if (this.settled) return;
        this.settled = true;
        for (const t of this.taskTimers.values()) clearTimeout(t);
        this.taskTimers.clear();
        if (this.globalTimer) { clearTimeout(this.globalTimer); this.globalTimer = null; }
        const resolve = this.resolveTransforms;
        this.resolveTransforms = undefined;
        resolve?.();
    }

    private drain(): void {
        if (this.closing) return;
        this.ensureWorkers();

        // Scan tasks first — they're lightweight and unblock BFS
        while (this.scanQueue.length > 0) {
            const idle = this.workers.find(w => !w.busy && !this.deadWorkers.has(w.idx));
            if (!idle) break;
            const task = this.scanQueue.shift()!;
            this.dispatchTask(idle, task);
        }
        // Then transform tasks
        while (this.pending.length > 0) {
            const idle = this.workers.find(w => !w.busy && !this.deadWorkers.has(w.idx));
            if (!idle) break;
            const task = this.pending.shift()!;
            this.dispatchTask(idle, task);
        }
    }

    private dispatchTask(w: TxWorker, task: WorkerTask): void {
        if (task.kind === 'transform' && task.source === undefined) {
            try { task.source = readText(task.localPath); }
            catch (e) {
                log.debug('precompile', () => `read fail: ${task.localPath}: ${errMsg(e)}`);
                this.specMap.delete(task.id);
                this.transformFail++;
                this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
                if (this.transformDone + this.transformFail >= this.taskTotal) this.finish();
                return;
            }
        }
        try {
            w.send(task);
        } catch (e) {
            this.deadWorkers.add(w.idx);
            log.debug('precompile', () => `dispatch fail: ${task.localPath}: ${errMsg(e)}`);
            this.specMap.delete(task.id);
            if (task.kind === 'scan') {
                const deps = this.resolveScanFallback(task.id, `dispatch fail: ${errMsg(e)}`);
                const cb = this.scanCallbacks.get(task.id);
                if (cb) {
                    this.scanCallbacks.delete(task.id);
                    cb(deps);
                }
            } else {
                this.transformFail++;
                this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
                if (this.transformDone + this.transformFail >= this.taskTotal) this.finish();
            }
            this.drain();
            return;
        }
        task.source = '';   // worker copied it; drop our reference to bound peak RSS
        this.workerTaskId.set(w.idx, task.id);
        this.taskInfo.set(task.id, { kind: task.kind, localPath: task.localPath, workerIdx: w.idx });
        // Scan tasks are lightweight (sucrase tokenize) — no timeout.
        // Only transform tasks get a safety timeout.
        if (task.kind === 'transform') {
            const timer = setTimeout(
                () => this.onTaskTimeout(task.id),
                ParseDriver.TRANSFORM_TASK_TIMEOUT_MS,
            );
            this.taskTimers.set(task.id, timer);
        }
    }

    private takeTask(taskId: number): { kind: WorkerTask['kind']; localPath: string; workerIdx: number } | null {
        const task = this.taskInfo.get(taskId);
        if (!task) return null;
        this.taskInfo.delete(taskId);
        this.workerTaskId.delete(task.workerIdx);
        const timer = this.taskTimers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this.taskTimers.delete(taskId);
        }
        return task;
    }

    private failTask(taskId: number, reason: string, allowScanFallback = false): void {
        const task = this.takeTask(taskId);
        if (!task) return;

        if (task.kind === 'scan') {
            const deps = allowScanFallback ? this.resolveScanFallback(taskId, reason) : [];
            const cb = this.scanCallbacks.get(taskId);
            if (cb) {
                this.scanCallbacks.delete(taskId);
                cb(deps);
            }
            if (!allowScanFallback) this.scanFallbacks.delete(taskId);
            log.debug('precompile', () => `${reason}: ${task.localPath}`);
            this.drain();
            return;
        }

        this.specMap.delete(taskId);
        this.transformFail++;
        log.debug('precompile', () => `${reason}: ${task.localPath}`);
        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
        this.drain();
        if (this.taskTotal > 0 && this.transformDone + this.transformFail >= this.taskTotal) this.finish();
    }

    private cancelOutstanding(): void {
        for (const queued of this.scanQueue) {
            const cb = this.scanCallbacks.get(queued.id);
            if (cb) {
                this.scanCallbacks.delete(queued.id);
                cb([]);
            }
            this.scanFallbacks.delete(queued.id);
        }
        this.scanQueue.length = 0;

        while (this.pending.length > 0) {
            const task = this.pending.shift()!;
            this.specMap.delete(task.id);
            this.transformFail++;
        }

        for (const taskId of [...this.taskInfo.keys()]) {
            this.failTask(taskId, 'cancelled during shutdown');
        }

        for (const timer of this.taskTimers.values()) clearTimeout(timer);
        this.taskTimers.clear();
        if (this.globalTimer) {
            clearTimeout(this.globalTimer);
            this.globalTimer = null;
        }
        this.workerTaskId.clear();
        this.taskInfo.clear();
        this.scanFallbacks.clear();
    }

    private resolveScanFallback(taskId: number, reason: string): string[] {
        const fallback = this.scanFallbacks.get(taskId);
        this.scanFallbacks.delete(taskId);
        if (!fallback) return [];

        log.debug('precompile', () => `${reason}, fallback inline: ${fallback.localPath}`);
        return this.scanInline(fallback.source, fallback.localPath);
    }

    async terminate(): Promise<void> {
        this.closing = true;
        this.cancelOutstanding();
        this.finish();

        log.debug('precompile', () => `terminating ${this.workers.length} workers`);
        const workers = this.workers.slice();
        for (const w of workers) {
            await w.terminate();
        }
        this.workers.length = 0;
        this.deadWorkers.clear();
        this.scanCallbacks.clear();
        this.specMap.clear();
    }
}

export const isCompilerWorker = isParseWorker;
export const runCompilerWorker = runParseWorker;
export const PrecompileDriver = ParseDriver;
