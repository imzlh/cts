import { Transformer, isPassthroughSource } from './source/transform';
import { OxcTranspiler, oxcExtPath, tryLoadOxc } from './oxc';
import { errMsg, log, getMemoryTier, readText, type MemoryTier } from './utils';
import { buildCjsWrapperSource } from './compile/cjs-wrap';
import type { ModuleFormat } from './types';

const { setTimeout, clearTimeout } = import.meta.use('timers');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const worker = import.meta.use('worker');
const smap = import.meta.use('sourcemap');
const asyncfs = import.meta.use('asyncfs');
const fs = import.meta.use('fs');

// ---------------------------------------------------------------------------
// Worker protocol — transform only (import scan is ImportScanner on main)
// ---------------------------------------------------------------------------

interface WorkerTask {
    id: number;
    kind: 'transform';
    localPath: string;
    /** Module runtime identity for Transformer.transform mapKey. */
    specPath?: string;
    lang?: string;
}

interface WorkerResult {
    id: number;
    code?: Uint8Array;
    sourceMap?: Uint8Array | object;
    error?: string;
}

interface WorkerPolicy {
    maxWorkers: number;
    source: string;
}

interface ParseWorkerData {
    __cts_role?: unknown;
    __cts_enable_oxc?: unknown;
}

// Compile transformed source to cacheable bytecode. CJS format is compiled
// as a sloppy-mode (EVAL_GLOBAL) compile-only script wrapped in the same CJS
// shape CjsLoader's fallback path builds — never as an engine.Module, since
// module code is unconditionally strict per spec and would silently change
// CJS semantics (implicit globals, non-strict `this`, etc). See
// cjs-wrap.ts and engine.d.ts's EVAL_COMPILE_ONLY / evalCompiled().
function compileForCache(code: string | Uint8Array, specPath: string, format: ModuleFormat | undefined): ArrayBuffer {
    if (format === 'cjs') {
        const src = typeof code === 'string' ? code : engine.decodeString(code);
        const compiled = engine.eval(buildCjsWrapperSource(src), specPath,
            engine.EVAL_GLOBAL | engine.EVAL_COMPILE_ONLY | engine.EVAL_NEW_BACKTRACE);
        return engine.serialize(compiled).buffer;
    }
    const mod = new engine.Module(code, specPath);
    return mod.dump();
}

/** Transform worker safety timeout (ms). Import scan never uses this pool. */
export function parseTaskTimeoutMs(_kind: 'transform' = 'transform'): number {
    return 60_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWorkerData(): ParseWorkerData {
    return isRecord(worker.workerData) ? worker.workerData : {};
}

function isWorkerTask(value: unknown): value is WorkerTask {
    return isRecord(value)
        && typeof value.id === 'number'
        && value.kind === 'transform'
        && typeof value.localPath === 'string'
        && (value.lang === undefined || typeof value.lang === 'string');
}

function isWorkerResult(value: unknown): value is WorkerResult {
    return isRecord(value)
        && typeof value.id === 'number';
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
    const cores = availableParallelism();
    if (tier === 'low' || cores <= 1) return 0;
    const transformCores = cores - 1;
    if (tier === 'normal') return Math.min(2, transformCores);
    return transformCores;
}

function parseWorkerOverride(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.floor(n));
}

function getWorkerEnv(): string | null {
    try {
        return os.getenv('CTS_WORKERS') ?? null;
    } catch {
        return null;
    }
}

function resolveWorkerPolicy(): WorkerPolicy {
    const raw = getWorkerEnv();
    const overridden = parseWorkerOverride(raw);
    if (overridden !== null) {
        return { maxWorkers: overridden, source: `CTS_WORKERS=${raw}` };
    }

    const tier = getMemoryTier();
    return { maxWorkers: workersForTier(tier), source: `memory-tier=${tier}` };
}

// ---------------------------------------------------------------------------
// In-worker: transform only
// ---------------------------------------------------------------------------

export function isParseWorker(): boolean {
    const role = parseWorkerData().__cts_role;
    return worker.isWorker && (role === 'parse' || role === 'compiler');
}

export async function runParseWorker(): Promise<void> {
    const pipe = worker.pipe;
    if (!pipe) throw new Error('Parse worker pipe is not available');
    const wd = parseWorkerData();
    // Sourcemaps are captured and relayed to the main thread instead of
    // registered here — this worker's JSContext is not where compiled
    // modules run, so a local smap.load() would be invisible to stack traces.
    const transformer = new Transformer({ sourceMaps: true });
    const oxcTranspiler: OxcTranspiler | null = wd.__cts_enable_oxc === false ? null : tryLoadOxc();
    if (oxcTranspiler) transformer.setOxc(oxcTranspiler);
    const postResult = (result: WorkerResult) => pipe.postMessage(result);
    const queue: WorkerTask[] = [];
    let processing = false;

    const runTask = async (task: WorkerTask): Promise<void> => {
        let bytes: Uint8Array;
        try {
            bytes = await asyncfs.readFile(task.localPath);
        } catch (e) {
            postResult({ id: task.id, error: errMsg(e) });
            return;
        }

        try {
            let result = transformer.transformCaptureBytes(bytes, task.localPath, task.lang, task.specPath);
            if (result === null) {
                const source = engine.decodeString(bytes);
                result = transformer.transformCapture(source, task.localPath, task.lang, task.specPath);
            }
            const { code, sourceMap } = result;
            postResult({
                id: task.id,
                code: code instanceof Uint8Array ? code : engine.toSharedBytes(code),
                sourceMap: sourceMap instanceof Uint8Array
                    ? sourceMap
                    : typeof sourceMap === 'string' ? engine.toSharedBytes(sourceMap) : sourceMap,
            });
        } catch (e) {
            postResult({ id: task.id, error: errMsg(e) });
        }
    };

    const drain = async (): Promise<void> => {
        if (processing) return;
        processing = true;
        try {
            while (queue.length > 0) {
                const task = queue.shift();
                if (!task) continue;
                try {
                    await runTask(task);
                } catch (e) {
                    try { postResult({ id: task.id, error: errMsg(e) }); } catch {}
                }
            }
        } finally {
            processing = false;
            if (queue.length > 0) void drain();
        }
    };

    pipe.onmessage = (raw: unknown) => {
        if (!isWorkerTask(raw)) return;
        queue.push(raw);
        void drain();
    };
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

class TxWorker {
    readonly w: CModuleWorker.Worker;
    readonly pipe: CModuleWorker.MessagePipe;
    inFlight = 0;
    idx: number;

    constructor(
        idx: number,
        onResult: (r: WorkerResult) => void,
        onError: (workerIdx: number, error: unknown) => void,
        enableOxc: boolean,
    ) {
        this.idx = idx;
        this.w = new worker.Worker({ __cts_role: 'parse', __cts_enable_oxc: enableOxc });
        this.pipe = this.w.messagePipe;
        this.pipe.onmessage = (data: unknown) => {
            if (isWorkerResult(data)) {
                this.inFlight = Math.max(0, this.inFlight - 1);
                onResult(data);
            } else {
                this.inFlight = 0;
                onError(this.idx, new Error('Invalid parse worker result'));
            }
        };
        this.pipe.onmessageerror = (error: unknown) => {
            this.inFlight = 0;
            onError(this.idx, error);
        };
    }

    send(task: WorkerTask): void {
        this.inFlight++;
        try {
            this.pipe.postMessage(task);
        } catch (e) {
            this.inFlight--;
            throw e;
        }
    }

    detach(): void {
        this.pipe.onmessage = undefined;
        this.pipe.onmessageerror = undefined;
    }

    stop(): void {
        this.detach();
        this.w.stop();
    }

    async terminate(): Promise<void> {
        this.detach();
        await this.w.terminate();
    }
}

// ---------------------------------------------------------------------------
// ParseDriver — transform / precompile only
// ---------------------------------------------------------------------------

export class ParseDriver {
    private workers: TxWorker[] = [];
    private pending: WorkerTask[] = [];
    /** id → {specPath, format} for in-flight transform tasks */
    private specMap = new Map<number, { specPath: string; format: ModuleFormat | undefined }>();
    private bytecodes = new Map<string, ArrayBuffer>();
    private onCompiled?: (localPath: string, bc: ArrayBuffer, specPath: string) => void;
    private onFailed?: (localPath: string, specPath: string, error: unknown) => void;
    private nextId = 0;
    private maxWorkers: number;
    private oxcPath: string | null;
    private oxc: OxcTranspiler | null;
    private inlineTransformer: Transformer | null = null;
    private taskTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private workerTaskIds = new Map<number, Set<number>>();
    private taskInfo = new Map<number, { localPath: string; workerIdx: number }>();
    private deadWorkers = new Set<number>();
    private settled = false;
    private closing = false;
    private transformDone = 0;
    private transformFail = 0;
    private taskTotal = 0;
    private resolveTransforms?: () => void;
    private onProgressCb?: (done: number, total: number) => void;

    private static readonly TRANSFORM_PREFETCH = 2;
    private static readonly GLOBAL_TIMEOUT_MS = 1200_000;
    private globalTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(oxc: OxcTranspiler | null = null, maxWorkers?: number) {
        this.oxc = oxc;
        this.oxcPath = oxc ? oxcExtPath() : null;
        const policy = resolveWorkerPolicy();
        this.maxWorkers = maxWorkers === undefined
            ? policy.maxWorkers
            : Number.isFinite(maxWorkers) ? Math.max(0, Math.floor(maxWorkers)) : 0;
        log.debug('precompile', () => `oxc path: ${this.oxcPath ?? 'not found'}`);
        const workerSource = maxWorkers === undefined ? policy.source : 'caller override';
        log.debug('precompile', () => `worker policy: ${this.maxWorkers === 0 ? 'inline' : `${this.maxWorkers} workers`} (${workerSource})`);
    }

    private ensureWorkers(): void {
        if (this.maxWorkers <= 0 || this.closing) return;
        const active = this.workerTaskIds.size;
        const desired = Math.min(this.maxWorkers, active + this.pending.length);
        let live = this.workers.length - this.deadWorkers.size;
        while (live < desired) {
            const w = new TxWorker(
                this.workers.length,
                (r) => this.onWorkerResult(r),
                (workerIdx, error) => this.onWorkerError(workerIdx, error),
                this.oxc !== null,
            );
            this.workers.push(w);
            live++;
            log.debug('precompile', () => `spawned worker ${w.idx}`);
        }
    }

    async compileModules(
        modules: Array<{ specPath: string; localPath: string; format?: ModuleFormat; lang?: string }>,
        onProgress?: (done: number, total: number) => void,
        onCompiled?: (localPath: string, bc: ArrayBuffer, specPath: string) => void,
        onFailed?: (localPath: string, specPath: string, error: unknown) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        if (this.closing) return new Map();
        if (!modules.length) return new Map();
        if (this.maxWorkers <= 0) {
            return this.compileModulesInline(modules, onProgress, onCompiled, onFailed);
        }

        this.onCompiled = onCompiled;
        this.onFailed = onFailed;
        this.bytecodes = new Map<string, ArrayBuffer>();

        log.debug('precompile', () => `queuing ${modules.length} modules`);

        const tasks: WorkerTask[] = [];
        const passthrough: Array<{ specPath: string; localPath: string; format?: ModuleFormat; lang?: string }> = [];
        for (const m of modules) {
            if (isPassthroughSource(m.localPath) && !m.lang) {
                passthrough.push(m);
                continue;
            }
            const id = this.nextId++;
            tasks.push({ id, kind: 'transform', localPath: m.localPath, specPath: m.specPath, lang: m.lang });
            this.specMap.set(id, { specPath: m.specPath, format: m.format });
        }

        this.taskTotal = modules.length;
        this.transformDone = 0;
        this.transformFail = 0;
        this.settled = false;
        this.onProgressCb = onProgress;

        const allTransformsDone = new Promise<void>(resolve => {
            this.resolveTransforms = resolve;
        });

        this.ensureWorkers();

        this.pending = tasks;
        // Safety net only — must abandon remaining work (not silently resolve).
        this.globalTimer = setTimeout(() => this.onGlobalTimeout(), ParseDriver.GLOBAL_TIMEOUT_MS);
        this.drain();
        for (const m of passthrough) this.compilePassthrough(m);
        if (this.transformDone + this.transformFail >= this.taskTotal) this.finish();

        await allTransformsDone;

        log.debug('precompile', () => `transforms: ${this.transformDone} ok, ${this.transformFail} fail`);
        log.debug('precompile', () => `outputs ${this.onCompiled ? 'streamed' : `${this.bytecodes.size} retained`} (${this.workers.length} workers)`);

        const out = this.bytecodes;
        this.bytecodes = new Map();
        this.specMap.clear();
        this.pending.length = 0;
        this.onCompiled = undefined;
        this.onFailed = undefined;
        this.onProgressCb = undefined;
        this.taskTotal = 0;
        return out;
    }

    /** Batch wall-clock limit: fail remaining tasks so pack/precache never see a silent half-graph. */
    private onGlobalTimeout(): void {
        if (this.settled) return;
        const left = this.pending.length + this.taskInfo.size;
        log.debug('precompile', () =>
            `global timeout (${ParseDriver.GLOBAL_TIMEOUT_MS}ms), abandoning ${left} remaining task(s)`);
        this.cancelOutstanding();
        this.finish();
    }

    async precompile(
        modules: Array<{ specPath: string; localPath: string; format?: ModuleFormat; lang?: string }>,
        onProgress?: (done: number, total: number) => void,
        onCompiled?: (localPath: string, bc: ArrayBuffer, specPath: string) => void,
        onFailed?: (localPath: string, specPath: string, error: unknown) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        return this.compileModules(modules, onProgress, onCompiled, onFailed);
    }

    private async compileModulesInline(
        modules: Array<{ specPath: string; localPath: string; format?: ModuleFormat; lang?: string }>,
        onProgress?: (done: number, total: number) => void,
        onCompiled?: (localPath: string, bc: ArrayBuffer, specPath: string) => void,
        onFailed?: (localPath: string, specPath: string, error: unknown) => void,
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
                const code = transformer.transform(source, m.localPath, m.lang, m.specPath);
                const bc = compileForCache(code, m.specPath, m.format);
                if (onCompiled) onCompiled(m.localPath, bc, m.specPath);
                else bytecodes.set(m.localPath, bc);
                done++;
            } catch (e) {
                fail++;
                log.debug('precompile', () => `inline compile fail: ${m.localPath}: ${errMsg(e)}`);
                onFailed?.(m.localPath, m.specPath, e);
            }
            onProgress?.(done + fail, total);
        }

        log.debug('precompile', () => `inline transforms: ${done} ok, ${fail} fail`);
        return bytecodes;
    }

    private getInlineTransformer(): Transformer {
        if (!this.inlineTransformer) {
            const transformer = new Transformer({ sourceMaps: true });
            if (this.oxc) transformer.setOxc(this.oxc);
            this.inlineTransformer = transformer;
        }
        return this.inlineTransformer;
    }

    private onWorkerResult(r: WorkerResult): void {
        const task = this.takeTask(r.id);
        if (!task) {
            log.debug('precompile', () => `late result discarded: ${r.id}`);
            return;
        }

        const entry = this.specMap.get(r.id);
        if (entry) this.specMap.delete(r.id);
        if (r.code && entry) {
            const { specPath, format } = entry;
            try {
                if (r.sourceMap) {
                    try {
                        if (r.sourceMap instanceof Uint8Array) smap.loadJSONBytes(specPath, r.sourceMap);
                        else smap.load(specPath, r.sourceMap);
                    } catch (e) { log.debug('precompile', () => `smap relay: ${task.localPath}: ${errMsg(e)}`); }
                }
                const bc = compileForCache(r.code, specPath, format);
                if (this.onCompiled) this.onCompiled(task.localPath, bc, specPath);
                else this.bytecodes.set(task.localPath, bc);
            } catch (e) {
                log.debug('precompile', () => `compile fail: ${task.localPath}: ${errMsg(e)}`);
                this.onFailed?.(task.localPath, specPath, e);
            }
            this.transformDone++;
        } else {
            this.transformFail++;
            log.debug('precompile', () => `transform fail: ${task.localPath}: ${r.error}`);
            this.onFailed?.(task.localPath, entry?.specPath ?? task.localPath, r.error);
        }
        r.code = undefined;
        r.sourceMap = undefined;
        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
        this.drain();
        if (this.transformDone + this.transformFail >= this.taskTotal) this.finish();
    }

    private compilePassthrough(m: { specPath: string; localPath: string; format?: ModuleFormat; lang?: string }): void {
        try {
            const bytes = new Uint8Array(fs.readFile(m.localPath));
            let bc: ArrayBuffer;
            if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) {
                const code = this.getInlineTransformer().transform(engine.decodeString(bytes), m.localPath, m.lang, m.specPath);
                bc = compileForCache(code, m.specPath, m.format);
            } else {
                try {
                    bc = compileForCache(bytes, m.specPath, m.format);
                } catch (e) {
                    try {
                        bc = compileForCache(engine.decodeString(bytes), m.specPath, m.format);
                    } catch {
                        throw e;
                    }
                }
            }
            if (this.onCompiled) this.onCompiled(m.localPath, bc, m.specPath);
            else this.bytecodes.set(m.localPath, bc);
            this.transformDone++;
        } catch (e) {
            this.transformFail++;
            log.debug('precompile', () => `passthrough compile fail: ${m.localPath}: ${errMsg(e)}`);
            this.onFailed?.(m.localPath, m.specPath, e);
        }
        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
    }

    private onWorkerError(workerIdx: number, error: unknown): void {
        const taskIds = [...(this.workerTaskIds.get(workerIdx) ?? [])];
        const suffix = taskIds.length > 0 ? ` while handling ${taskIds.length} task(s)` : '';
        log.debug('precompile', () => `worker ${workerIdx} message error${suffix}: ${errMsg(error)}`);
        this.deadWorkers.add(workerIdx);
        for (const taskId of taskIds) {
            this.failTask(taskId, `worker ${workerIdx} message error: ${errMsg(error)}`);
        }
        this.workers[workerIdx]?.stop();
        this.drain();
    }

    private onTaskTimeout(taskId: number): void {
        const timedTask = this.taskInfo.get(taskId);
        if (!timedTask) return;
        const timeout = parseTaskTimeoutMs('transform');
        this.deadWorkers.add(timedTask.workerIdx);
        this.workers[timedTask.workerIdx]?.stop();
        const taskIds = [...(this.workerTaskIds.get(timedTask.workerIdx) ?? [])];
        for (const id of taskIds) {
            const task = this.taskInfo.get(id);
            if (!task) continue;
            const reason = id === taskId
                ? `transform timeout (${timeout}ms), worker ${task.workerIdx} dead`
                : `worker ${task.workerIdx} stopped after task ${taskId} timeout`;
            this.failTask(id, reason);
        }

        this.drain();

        if (this.deadWorkers.size >= this.workers.length) {
            if (this.pending.length > 0) {
                log.debug('precompile', () => `all workers dead, abandoning ${this.pending.length} transform tasks`);
                while (this.pending.length > 0) {
                    const t = this.pending.shift();
                    if (!t) break;
                    const specPath = this.specMap.get(t.id)?.specPath ?? t.localPath;
                    this.specMap.delete(t.id);
                    this.transformFail++;
                    log.debug('precompile', () => `abandoned: ${t.localPath}`);
                    this.onFailed?.(t.localPath, specPath, new Error('all parse workers stopped'));
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
        if (this.globalTimer) {
            clearTimeout(this.globalTimer);
            this.globalTimer = null;
        }
        const resolve = this.resolveTransforms;
        this.resolveTransforms = undefined;
        resolve?.();
    }

    private drain(): void {
        if (this.closing) return;
        this.ensureWorkers();

        while (this.pending.length > 0) {
            const idle = this.workers.find(w =>
                w.inFlight < ParseDriver.TRANSFORM_PREFETCH && !this.deadWorkers.has(w.idx));
            if (!idle) break;
            const task = this.pending.shift();
            if (!task) break;
            this.sendToWorker(idle, task);
        }
    }

    private sendToWorker(w: TxWorker, task: WorkerTask): void {
        this.taskInfo.set(task.id, { localPath: task.localPath, workerIdx: w.idx });
        let taskIds = this.workerTaskIds.get(w.idx);
        if (!taskIds) {
            taskIds = new Set();
            this.workerTaskIds.set(w.idx, taskIds);
        }
        taskIds.add(task.id);
        const timeout = parseTaskTimeoutMs('transform');
        const timer = setTimeout(() => this.onTaskTimeout(task.id), timeout);
        this.taskTimers.set(task.id, timer);
        try {
            w.send(task);
        } catch (e) {
            this.deadWorkers.add(w.idx);
            log.debug('precompile', () => `dispatch fail: ${task.localPath}: ${errMsg(e)}`);
            this.failTask(task.id, `dispatch fail: ${errMsg(e)}`);
            return;
        }
    }

    private takeTask(taskId: number): { localPath: string; workerIdx: number } | null {
        const task = this.taskInfo.get(taskId);
        if (!task) return null;
        this.taskInfo.delete(taskId);
        const taskIds = this.workerTaskIds.get(task.workerIdx);
        taskIds?.delete(taskId);
        if (taskIds?.size === 0) this.workerTaskIds.delete(task.workerIdx);
        const timer = this.taskTimers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this.taskTimers.delete(taskId);
        }
        return task;
    }

    private failTask(taskId: number, reason: string): void {
        const task = this.takeTask(taskId);
        if (!task) return;

        const specPath = this.specMap.get(taskId)?.specPath ?? task.localPath;
        this.specMap.delete(taskId);
        this.transformFail++;
        log.debug('precompile', () => `${reason}: ${task.localPath}`);
        this.onFailed?.(task.localPath, specPath, new Error(reason));
        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
        this.drain();
        if (this.taskTotal > 0 && this.transformDone + this.transformFail >= this.taskTotal) this.finish();
    }

    private cancelOutstanding(): void {
        let cancelledPending = 0;
        while (this.pending.length > 0) {
            const task = this.pending.shift();
            if (!task) break;
            const specPath = this.specMap.get(task.id)?.specPath ?? task.localPath;
            this.specMap.delete(task.id);
            this.transformFail++;
            cancelledPending++;
            this.onFailed?.(task.localPath, specPath, new Error('cancelled during shutdown'));
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
        this.workerTaskIds.clear();
        this.taskInfo.clear();
        // failTask reports in-flight cancellations itself. Only pending tasks
        // need one final aggregate update, and a completed batch needs none.
        if (cancelledPending > 0 && this.taskTotal > 0) {
            this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
        }
    }

    async terminate(): Promise<void> {
        this.closing = true;
        this.cancelOutstanding();
        this.finish();

        log.debug('precompile', () => `terminating ${this.workers.length} workers`);
        const workers = this.workers.slice();
        for (const w of workers) w.stop();
        for (const w of workers) {
            await w.terminate();
        }
        this.workers.length = 0;
        this.deadWorkers.clear();
        this.specMap.clear();
    }
}
