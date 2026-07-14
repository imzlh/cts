import { Transformer, isPassthroughSource } from './source/transform';
import { OxcTranspiler, oxcExtPath, tryLoadOxc } from './oxc';
import { ImportScanner } from './import-scanner';
import { errMsg, log, getMemoryTier, getMemoryFile, readBytes, readText, type MemoryTier } from './utils';
import { buildCjsWrapperSource } from './compile/cjs-wrap';
import type { ModuleFormat } from './types';

const { setTimeout, clearTimeout } = import.meta.use('timers');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const worker = import.meta.use('worker');
const smap = import.meta.use('sourcemap');
const asyncfs = import.meta.use('asyncfs');

// Workers read/scan/transform; QuickJS bytecode compilation stays on main.

interface WorkerTask {
    id: number;
    kind: 'scan' | 'transform';
    localPath: string;
    /** Module runtime identity for Transformer.transform mapKey. */
    specPath?: string;
    lang?: string;
}

interface WorkerResult {
    id: number;
    deps?: string[];
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

interface ScanCallback {
    resolve: (deps: string[]) => void;
    reject: (error: Error) => void;
}

export class ParseWorkerError extends Error {
    override name = 'ParseWorkerError';
}

export function isParseWorkerError(error: unknown): error is ParseWorkerError {
    return error instanceof ParseWorkerError;
}

// Bytecode: CJS via cjs-wrap; ESM via Module.dump() under stub onModule (no dep cascade).
// CJS must strip TS/JSX first — workers only run ESM transform; .cts is main-thread.
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

function prepareForCache(
    transformer: Transformer,
    code: string,
    localPath: string,
    format: ModuleFormat | undefined,
    lang?: string,
    mapKey?: string,
): string {
    // CJS keeps require/exports; transform() would rewrite import/export.
    if (format === 'cjs') return transformer.transformForCjs(code, localPath, lang);
    return transformer.transform(code, localPath, lang, mapKey);
}

/** Transform worker safety timeout (ms). Scan tasks have no wall-clock kill. */
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
        && (value.kind === 'scan' || value.kind === 'transform')
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

export function isParseWorker(): boolean {
    const role = parseWorkerData().__cts_role;
    return worker.isWorker && (role === 'parse' || role === 'compiler');
}

export async function runParseWorker(): Promise<void> {
    const pipe = worker.pipe;
    if (!pipe) throw new Error('Parse worker pipe is not available');
    const wd = parseWorkerData();
    // Relay sourcemaps to main; worker JSContext is not where modules run.
    const transformer = new Transformer({ sourceMaps: true });
    const oxcTranspiler: OxcTranspiler | null = wd.__cts_enable_oxc === false ? null : tryLoadOxc();
    if (oxcTranspiler) transformer.setOxc(oxcTranspiler);
    const importScanner = new ImportScanner(oxcTranspiler);
    const postResult = (result: WorkerResult) => pipe.postMessage(result);
    const queue: WorkerTask[] = [];
    let processing = false;

    const runTask = async (task: WorkerTask): Promise<void> => {
        let bytes: Uint8Array;
        try {
            // Pack/VFS paths are not on disk; workers share process store when installed.
            const mem = getMemoryFile(task.localPath);
            bytes = mem !== undefined ? mem : await asyncfs.readFile(task.localPath);
        } catch (e) {
            postResult({ id: task.id, error: errMsg(e) });
            return;
        }

        try {
            if (task.kind === 'scan') {
                postResult({ id: task.id, deps: importScanner.scanBytes(bytes, task.localPath, task.lang) });
                return;
            }
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

class TxWorker {
    readonly w: CModuleWorker.Worker;
    readonly pipe: CModuleWorker.MessagePipe;
    inFlight = 0;
    idx: number;
    private stopped = false;
    private termination: Promise<void> | null = null;

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
        if (this.stopped) return;
        this.stopped = true;
        this.detach();
        this.w.stop();
    }

    terminate(): Promise<void> {
        if (!this.termination) {
            this.stop();
            this.termination = Promise.resolve(this.w.terminate());
        }
        return this.termination;
    }
}

// ParseDriver — worker scan/transform, main-thread bytecode compile

export class ParseDriver {
    private workers: TxWorker[] = [];
    private pending: WorkerTask[] = [];
    private scanQueue: WorkerTask[] = [];
    private scanCallbacks = new Map<number, ScanCallback>();
    /** id → {specPath, format} for in-flight transform tasks */
    private specMap = new Map<number, { specPath: string; format: ModuleFormat | undefined }>();
    private bytecodes = new Map<string, ArrayBuffer>();
    private onCompiled?: (localPath: string, bc: ArrayBuffer, specPath: string) => void;
    private onFailed?: (localPath: string, specPath: string, error: unknown) => void;
    private nextId = 0;
    private maxWorkers: number;
    private oxcPath: string | null;
    private oxc: OxcTranspiler | null;
    private readonly importScanner: ImportScanner;
    private inlineTransformer: Transformer | null = null;
    private taskTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private workerTaskIds = new Map<number, Set<number>>();
    private taskInfo = new Map<number, { task: WorkerTask; workerIdx: number }>();
    private taskRetries = new Map<number, number>();
    private deadWorkers = new Set<number>();
    private retiringWorkers = new Set<number>();
    private workerFailure: ParseWorkerError | null = null;
    private spawnFailures = 0;
    private settled = false;
    private closing = false;
    private transformDone = 0;
    private transformFail = 0;
    private taskTotal = 0;
    private resolveTransforms?: () => void;
    private rejectTransforms?: (error: Error) => void;
    private onProgressCb?: (done: number, total: number) => void;

    private static readonly MAX_WORKER_RETRIES = 2;
    private static readonly TRANSFORM_PREFETCH = 2;
    private static readonly GLOBAL_TIMEOUT_MS = 1200_000;
    private globalTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(oxc: OxcTranspiler | null = null, maxWorkers?: number) {
        this.oxc = oxc;
        this.oxcPath = oxc ? oxcExtPath() : null;
        this.importScanner = new ImportScanner(oxc);
        const policy = resolveWorkerPolicy();
        this.maxWorkers = maxWorkers === undefined
            ? policy.maxWorkers
            : Number.isFinite(maxWorkers) ? Math.max(0, Math.floor(maxWorkers)) : 0;
        log.debug('precompile', () => `oxc path: ${this.oxcPath ?? 'not found'}`);
        const workerSource = maxWorkers === undefined ? policy.source : 'caller override';
        log.debug('precompile', () => `worker policy: ${this.maxWorkers === 0 ? 'inline' : `${this.maxWorkers} workers`} (${workerSource})`);
    }

    private ensureWorkers(): void {
        if (this.maxWorkers <= 0 || this.closing || this.workerFailure) return;
        // Native worker teardown must join before a replacement is created.
        if (this.retiringWorkers.size > 0) return;
        const active = this.workerTaskIds.size;
        const desired = Math.min(this.maxWorkers, active + this.scanQueue.length + this.pending.length);
        let live = this.workers.length - this.deadWorkers.size;
        while (live < desired) {
            let w: TxWorker;
            try {
                w = new TxWorker(
                    this.workers.length,
                    (r) => this.onWorkerResult(r),
                    (workerIdx, error) => this.onWorkerError(workerIdx, error),
                    this.oxc !== null,
                );
                this.spawnFailures = 0;
            } catch (e) {
                this.spawnFailures++;
                const reason = `parse worker spawn failed (${this.spawnFailures}/${ParseDriver.MAX_WORKER_RETRIES + 1}): ${errMsg(e)}`;
                log.debug('precompile', () => reason);
                if (this.spawnFailures > ParseDriver.MAX_WORKER_RETRIES) {
                    this.failInfrastructure(new ParseWorkerError(reason));
                    return;
                }
                continue;
            }
            this.workers.push(w);
            live++;
            log.debug('precompile', () => `spawned worker ${w.idx}`);
        }
    }

    /**
     * Import extraction for dep scan.
     * oxc is native and cheap on the main thread — worker IPC dominates for 1k+
     * small files and shows up as main-thread 100% (resolve + wait). Workers only
     * help when falling back to Sucrase (no oxc).
     */
    async scanFile(localPath: string, lang?: string): Promise<string[]> {
        if (this.closing) throw new ParseWorkerError('parse worker pool is closing');
        if (this.workerFailure) throw this.workerFailure;
        // Prefer main-thread oxc (or forced inline). Worker path is Sucrase-only.
        if (this.oxc || this.maxWorkers <= 0) {
            const result = this.importScanner.scanFileResult(localPath, lang);
            if (result === null) throw new Error(`Could not read source for import scan: ${localPath}`);
            return result;
        }

        const id = this.nextId++;
        const task: WorkerTask = { id, kind: 'scan', localPath, lang };
        return new Promise<string[]>((resolve, reject) => {
            this.scanCallbacks.set(id, { resolve, reject });
            this.scanQueue.push(task);
            this.drain();
        });
    }

    async compileModules(
        modules: Array<{ specPath: string; localPath: string; format?: ModuleFormat; lang?: string }>,
        onProgress?: (done: number, total: number) => void,
        onCompiled?: (localPath: string, bc: ArrayBuffer, specPath: string) => void,
        onFailed?: (localPath: string, specPath: string, error: unknown) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        if (this.closing) return new Map();
        if (this.workerFailure) throw this.workerFailure;
        if (!modules.length) return new Map();
        if (this.maxWorkers <= 0) {
            return this.compileModulesInline(modules, onProgress, onCompiled, onFailed);
        }

        this.onCompiled = onCompiled;
        this.onFailed = onFailed;
        this.bytecodes = new Map<string, ArrayBuffer>();

        log.debug('precompile', () => `queuing ${modules.length} modules`);

        const tasks: WorkerTask[] = [];
        // CJS (+ plain passthrough) stay on main: transformForCjs is not worker-side.
        const mainThread: Array<{ specPath: string; localPath: string; format?: ModuleFormat; lang?: string }> = [];
        for (const m of modules) {
            if (m.format === 'cjs' || (isPassthroughSource(m.localPath) && !m.lang)) {
                mainThread.push(m);
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

        const allTransformsDone = new Promise<void>((resolve, reject) => {
            this.resolveTransforms = resolve;
            this.rejectTransforms = reject;
        });

        this.ensureWorkers();

        this.pending = tasks;
        // Safety net only — must abandon remaining work (not silently resolve).
        this.globalTimer = setTimeout(() => this.onGlobalTimeout(), ParseDriver.GLOBAL_TIMEOUT_MS);
        this.drain();
        for (const m of mainThread) this.compileOnMain(m);
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
        this.resolveTransforms = undefined;
        this.rejectTransforms = undefined;
        this.taskTotal = 0;
        return out;
    }

    /** Batch wall-clock limit: fail remaining tasks so pack/precache never see a silent half-graph. */
    private onGlobalTimeout(): void {
        if (this.settled) return;
        const left = this.pending.length + this.taskInfo.size;
        const error = new ParseWorkerError(
            `parse worker batch timeout (${ParseDriver.GLOBAL_TIMEOUT_MS}ms), ${left} task(s) remaining`);
        log.debug('precompile', () => error.message);
        this.failInfrastructure(error);
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
                const code = prepareForCache(transformer, source, m.localPath, m.format, m.lang, m.specPath);
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
        const taken = this.takeTask(r.id);
        if (!taken) {
            log.debug('precompile', () => `late result discarded: ${r.id}`);
            return;
        }
        const task = taken.task;

        if (task.kind === 'scan') {
            if (!Array.isArray(r.deps) && !r.error) {
                this.retryTask(task, 'invalid scan worker result');
            } else {
                const callback = this.scanCallbacks.get(task.id);
                this.scanCallbacks.delete(task.id);
                this.taskRetries.delete(task.id);
                if (r.error) callback?.reject(new Error(`Import scan failed for ${task.localPath}: ${r.error}`));
                else callback?.resolve(r.deps ?? []);
            }
            this.drain();
            return;
        }

        if (!r.code && !r.error) {
            this.retryTask(task, 'invalid transform worker result');
            this.drain();
            return;
        }

        const entry = this.specMap.get(r.id);
        if (entry) this.specMap.delete(r.id);
        this.taskRetries.delete(task.id);
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

    /** Main-thread compile: CJS (transformForCjs) or plain JS passthrough. */
    private compileOnMain(m: { specPath: string; localPath: string; format?: ModuleFormat; lang?: string }): void {
        try {
            const transformer = this.getInlineTransformer();
            let bc: ArrayBuffer;
            if (m.format === 'cjs') {
                // Always strip TS/JSX; .cts must not hit EVAL_COMPILE_ONLY raw.
                const code = prepareForCache(transformer, readText(m.localPath), m.localPath, 'cjs', m.lang, m.specPath);
                bc = compileForCache(code, m.specPath, 'cjs');
            } else {
                const bytes = readBytes(m.localPath);
                if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) {
                    const code = prepareForCache(
                        transformer, engine.decodeString(bytes), m.localPath, m.format, m.lang, m.specPath);
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
            }
            if (this.onCompiled) this.onCompiled(m.localPath, bc, m.specPath);
            else this.bytecodes.set(m.localPath, bc);
            this.transformDone++;
        } catch (e) {
            this.transformFail++;
            log.debug('precompile', () => `main compile fail: ${m.localPath}: ${errMsg(e)}`);
            this.onFailed?.(m.localPath, m.specPath, e);
        }
        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
    }

    private onWorkerError(workerIdx: number, error: unknown): void {
        const taskIds = [...(this.workerTaskIds.get(workerIdx) ?? [])];
        const suffix = taskIds.length > 0 ? ` while handling ${taskIds.length} task(s)` : '';
        const reason = `worker ${workerIdx} transport error${suffix}: ${errMsg(error)}`;
        log.debug('precompile', () => reason);
        this.deadWorkers.add(workerIdx);
        this.retireWorker(workerIdx);
        for (const taskId of taskIds) {
            const taken = this.takeTask(taskId);
            if (taken) this.retryTask(taken.task, reason);
        }
        this.drain();
    }

    private onTaskTimeout(taskId: number): void {
        const timedTask = this.taskInfo.get(taskId);
        if (!timedTask) return;
        const timeout = parseTaskTimeoutMs('transform');
        this.deadWorkers.add(timedTask.workerIdx);
        this.retireWorker(timedTask.workerIdx);
        const taskIds = [...(this.workerTaskIds.get(timedTask.workerIdx) ?? [])];
        for (const id of taskIds) {
            const taken = this.takeTask(id);
            if (!taken) continue;
            const reason = id === taskId
                ? `worker ${taken.workerIdx} transform timeout (${timeout}ms)`
                : `worker ${taken.workerIdx} stopped after task ${taskId} timeout`;
            this.retryTask(taken.task, reason);
        }

        this.drain();
    }

    private retireWorker(workerIdx: number): void {
        const failed = this.workers[workerIdx];
        if (!failed || this.retiringWorkers.has(workerIdx)) return;
        this.retiringWorkers.add(workerIdx);
        failed.stop();
        void failed.terminate().then(() => {
            this.retiringWorkers.delete(workerIdx);
            this.drain();
        }).catch((e: unknown) => {
            this.retiringWorkers.delete(workerIdx);
            this.failInfrastructure(new ParseWorkerError(
                `parse worker ${workerIdx} teardown failed: ${errMsg(e)}`));
        });
    }

    private finish(error?: Error): void {
        if (this.settled) return;
        this.settled = true;
        for (const t of this.taskTimers.values()) clearTimeout(t);
        this.taskTimers.clear();
        if (this.globalTimer) {
            clearTimeout(this.globalTimer);
            this.globalTimer = null;
        }
        const resolve = this.resolveTransforms;
        const reject = this.rejectTransforms;
        this.resolveTransforms = undefined;
        this.rejectTransforms = undefined;
        if (error) reject?.(error);
        else resolve?.();
    }

    private drain(): void {
        if (this.closing || this.workerFailure) return;
        this.ensureWorkers();

        while (this.scanQueue.length > 0) {
            const idle = this.workers.find(w => w.inFlight === 0 && !this.deadWorkers.has(w.idx));
            if (!idle) break;
            const task = this.scanQueue.shift();
            if (!task) break;
            this.sendToWorker(idle, task);
        }

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
        this.taskInfo.set(task.id, { task, workerIdx: w.idx });
        let taskIds = this.workerTaskIds.get(w.idx);
        if (!taskIds) {
            taskIds = new Set();
            this.workerTaskIds.set(w.idx, taskIds);
        }
        taskIds.add(task.id);
        if (task.kind === 'transform') {
            const timeout = parseTaskTimeoutMs('transform');
            const timer = setTimeout(() => this.onTaskTimeout(task.id), timeout);
            this.taskTimers.set(task.id, timer);
        }
        try {
            w.send(task);
        } catch (e) {
            this.onWorkerError(w.idx, e);
        }
    }

    private takeTask(taskId: number): { task: WorkerTask; workerIdx: number } | null {
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

    private retryTask(task: WorkerTask, reason: string): void {
        const retries = (this.taskRetries.get(task.id) ?? 0) + 1;
        if (retries > ParseDriver.MAX_WORKER_RETRIES) {
            this.taskRetries.delete(task.id);
            const error = new ParseWorkerError(
                `Parse worker infrastructure failed after ${retries} attempts: ${reason}`);
            this.failInfrastructure(error);
            return;
        }

        this.taskRetries.set(task.id, retries);
        log.debug('precompile', () =>
            `${reason}; retry ${retries}/${ParseDriver.MAX_WORKER_RETRIES}: ${task.localPath}`);
        if (task.kind === 'scan') this.scanQueue.unshift(task);
        else this.pending.unshift(task);
    }

    private failInfrastructure(error: ParseWorkerError): void {
        if (this.workerFailure) return;
        this.workerFailure = error;
        this.cancelOutstanding(error);
        this.finish(error);
    }

    private cancelOutstanding(error = new ParseWorkerError('parse worker pool terminated')): void {
        for (const task of this.scanQueue) this.taskRetries.delete(task.id);
        this.scanQueue.length = 0;

        while (this.pending.length > 0) {
            const task = this.pending.shift();
            if (!task) break;
            this.specMap.delete(task.id);
            this.taskRetries.delete(task.id);
        }

        for (const taskId of [...this.taskInfo.keys()]) {
            const taken = this.takeTask(taskId);
            if (!taken) continue;
            if (taken.task.kind === 'transform') this.specMap.delete(taskId);
            this.taskRetries.delete(taskId);
        }

        for (const callback of this.scanCallbacks.values()) callback.reject(error);
        this.scanCallbacks.clear();

        for (const timer of this.taskTimers.values()) clearTimeout(timer);
        this.taskTimers.clear();
        if (this.globalTimer) {
            clearTimeout(this.globalTimer);
            this.globalTimer = null;
        }
        this.workerTaskIds.clear();
        this.taskInfo.clear();
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
        this.retiringWorkers.clear();
        this.workerFailure = null;
        this.spawnFailures = 0;
        this.specMap.clear();
        this.taskRetries.clear();
    }
}
