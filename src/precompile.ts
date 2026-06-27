// precompile.ts — Worker-parallel transform + main-thread QJS compile
//
// Phase 1 (Worker-parallel): N workers do transform (oxc preferred, sucrase fallback)
// Phase 2 (main-thread):    QJS new Module + dump → bytecode (C layer, fast)
//
// Workers also handle import scanning (kind:'scan') during BFS — same pool,
// scan tasks are dispatched first since they unblock the dependency graph.

import { Transformer } from './source/transform';
import { OxcTranspiler, oxcExtPath, type OxcModule } from './oxc';
import { extractImports } from './scan';
import { readText } from './utils/io';
import { errMsg } from './utils/misc';
import { log } from './utils/log';

const { setTimeout, clearTimeout } = import.meta.use('timers');
const os = import.meta.use('os');
const engine = import.meta.use('engine');
const worker = import.meta.use('worker');

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

interface WorkerTask {
    id: number;
    kind: 'transform' | 'scan';
    localPath: string;
    source: string;
}

interface WorkerResult {
    id: number;
    kind: 'transform' | 'scan';
    localPath: string;
    code?: string;    // transform
    deps?: string[];  // scan
    error?: string;
}

// ---------------------------------------------------------------------------
// In-worker: load oxc + sucrase fallback, handle both task kinds
// ---------------------------------------------------------------------------

export function isCompilerWorker(): boolean {
    return worker.isWorker && (worker.workerData as any)?.__cts_role === 'compiler';
}

export async function runCompilerWorker(): Promise<void> {
    const pipe = worker.pipe!;
    const wd = worker.workerData as any;
    const transformer = new Transformer({ sourceMaps: false });
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

        if (task.kind === 'scan') {
            try {
                let deps: string[] | null = null;
                if (oxcTranspiler) {
                    try { deps = oxcTranspiler.scanImports(task.source, task.localPath); } catch {}
                }
                if (deps === null) {
                    const isTs = /\.[mc]?tsx?$/.test(task.localPath);
                    deps = extractImports(task.source, isTs);
                }
                pipe.postMessage({ id: task.id, kind: 'scan', localPath: task.localPath, deps } as WorkerResult);
            } catch (e) {
                pipe.postMessage({ id: task.id, kind: 'scan', localPath: task.localPath, deps: [], error: errMsg(e) } as WorkerResult);
            }
            return;
        }

        try {
            const code = transformer.transform(task.source, task.localPath);
            pipe.postMessage({ id: task.id, kind: 'transform', localPath: task.localPath, code } as WorkerResult);
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

    constructor(idx: number, oxcPath: string | null, onResult: (r: WorkerResult) => void) {
        this.idx = idx;
        this.w = new worker.Worker({ __cts_role: 'compiler', __oxc_path: oxcPath });
        this.pipe = this.w.messagePipe;
        this.pipe.onmessage = (data: any) => {
            this.busy = false;
            onResult(data as WorkerResult);
        };
    }

    send(task: WorkerTask): void {
        this.busy = true;
        this.pipe.postMessage(task);
    }

    async terminate(): Promise<void> {
        await this.w.terminate();
    }
}

// ---------------------------------------------------------------------------
// PrecompileDriver
// ---------------------------------------------------------------------------

export class PrecompileDriver {
    private workers: TxWorker[] = [];
    /** Transform batch tasks — dispatched after scan tasks */
    private pending: WorkerTask[] = [];
    /** Scan tasks — dispatched first (lightweight, unblock BFS) */
    private scanQueue: WorkerTask[] = [];
    private results = new Map<number, WorkerResult>();
    private scanCallbacks = new Map<number, (deps: string[]) => void>();
    private nextId = 0;
    private maxWorkers: number;
    private oxcPath: string | null;
    private taskTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private workerTaskId = new Map<number, number>(); // worker.idx → current task id
    private deadWorkers = new Set<number>();
    private settled = false;
    private transformDone = 0;
    private transformFail = 0;
    private taskTotal = 0;
    private resolveTransforms?: () => void;
    private onProgressCb?: (done: number, total: number) => void;

    private static readonly TASK_TIMEOUT_MS = 60_000;
    private static readonly GLOBAL_TIMEOUT_MS = 1200_000;
    private globalTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        try {
            const n = os.getenv('CTS_WORKERS');
            if (n) this.maxWorkers = Math.max(1, Math.min(+n, 16));
            else this.maxWorkers = 4;
        } catch { this.maxWorkers = 4; }
        this.oxcPath = oxcExtPath();
        log.debug('precompile', () => `oxc path: ${this.oxcPath ?? 'not found'}`);
    }

    /** Lazily start workers. Called by both scanFile() and precompile(). */
    private ensureWorkers(): void {
        if (this.workers.length > 0) return;
        while (this.workers.length < this.maxWorkers) {
            const w = new TxWorker(this.workers.length, this.oxcPath, (r) => this.onWorkerResult(r));
            this.workers.push(w);
            log.debug('precompile', () => `spawned worker ${w.idx}`);
        }
    }

    /**
     * Scan a source file for import specifiers using the worker pool.
     * Workers handle OXC (if available) with Sucrase fallback.
     * Can be called concurrently during BFS before precompile() is invoked.
     */
    async scanFile(source: string, localPath: string): Promise<string[]> {
        this.ensureWorkers();
        const id = this.nextId++;
        const task: WorkerTask = { id, kind: 'scan', localPath, source };
        return new Promise<string[]>(resolve => {
            this.scanCallbacks.set(id, resolve);
            this.scanQueue.push(task);
            this.drain();
        });
    }

    async precompile(
        modules: Array<{ specPath: string; localPath: string }>,
        onProgress?: (done: number, total: number) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        if (!modules.length) return new Map();

        const bytecodes = new Map<string, ArrayBuffer>();

        log.debug('precompile', () => `reading ${modules.length} sources`);

        const tasks: WorkerTask[] = [];
        const specMap = new Map<number, string>(); // id → specPath
        for (const m of modules) {
            let source: string;
            try { source = readText(m.localPath); }
            catch (e) {
                log.debug('precompile', () => `read fail: ${m.localPath}: ${errMsg(e)}`);
                continue;
            }
            const id = this.nextId++;
            tasks.push({ id, kind: 'transform', localPath: m.localPath, source });
            specMap.set(id, m.specPath);
        }

        if (!tasks.length) return bytecodes;

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

        this.globalTimer = setTimeout(() => this.finish(), PrecompileDriver.GLOBAL_TIMEOUT_MS);

        await allTransformsDone;

        log.debug('precompile', () => `transforms: ${this.transformDone} ok, ${this.transformFail} fail`);

        // Phase 2: QJS compile on main thread
        let compileDone = 0;
        for (const t of tasks) {
            const r = this.results.get(t.id);
            if (!r?.code) continue;
            const specPath = specMap.get(t.id)!;
            try {
                const mod = new engine.Module(r.code, specPath);
                const bc = mod.dump();
                bytecodes.set(t.localPath, bc);
            } catch (e) {
                log.debug('precompile', () => `compile fail: ${t.localPath}: ${errMsg(e)}`);
            }
            compileDone++;
            onProgress?.(this.taskTotal + compileDone, this.taskTotal * 2);
        }

        log.debug('precompile', () => `compiled ${bytecodes.size}/${tasks.length} (${this.workers.length} workers)`);
        return bytecodes;
    }

    private onWorkerResult(r: WorkerResult): void {
        let taskActive = false;
        for (const [wIdx, taskId] of this.workerTaskId) {
            if (taskId === r.id) { taskActive = true; this.workerTaskId.delete(wIdx); break; }
        }
        if (!taskActive) {
            log.debug('precompile', () => `late result discarded: ${r.localPath}`);
            return;
        }

        const timer = this.taskTimers.get(r.id);
        if (timer) { clearTimeout(timer); this.taskTimers.delete(r.id); }

        if (r.kind === 'scan') {
            const cb = this.scanCallbacks.get(r.id);
            if (cb) {
                this.scanCallbacks.delete(r.id);
                cb(r.deps ?? []);
            }
            this.drain();
            return;
        }

        this.results.set(r.id, r);
        if (r.code) this.transformDone++;
        else { this.transformFail++; log.debug('precompile', () => `transform fail: ${r.localPath}: ${r.error}`); }
        this.onProgressCb?.(this.transformDone + this.transformFail, this.taskTotal);
        this.drain();
        if (this.transformDone + this.transformFail >= this.taskTotal) this.finish();
    }

    private onTaskTimeout(taskId: number, localPath: string, kind: 'transform' | 'scan', workerIdx: number): void {
        this.taskTimers.delete(taskId);
        this.workerTaskId.delete(workerIdx);
        this.deadWorkers.add(workerIdx);

        if (kind === 'scan') {
            const cb = this.scanCallbacks.get(taskId);
            if (cb) { this.scanCallbacks.delete(taskId); cb([]); }
            log.debug('precompile', () => `scan timeout (${PrecompileDriver.TASK_TIMEOUT_MS}ms): ${localPath}`);
        } else {
            this.transformFail++;
            log.debug('precompile', () => `transform timeout (${PrecompileDriver.TASK_TIMEOUT_MS}ms): ${localPath} (worker ${workerIdx} dead)`);
        }

        this.drain();

        if (this.deadWorkers.size >= this.workers.length) {
            // All workers dead — abandon remaining queued tasks
            while (this.scanQueue.length > 0) {
                const t = this.scanQueue.shift()!;
                const cb = this.scanCallbacks.get(t.id);
                if (cb) { this.scanCallbacks.delete(t.id); cb([]); }
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
        this.resolveTransforms?.();
    }

    private drain(): void {
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
        w.send(task);
        this.workerTaskId.set(w.idx, task.id);
        const timer = setTimeout(
            () => this.onTaskTimeout(task.id, task.localPath, task.kind, w.idx),
            PrecompileDriver.TASK_TIMEOUT_MS,
        );
        this.taskTimers.set(task.id, timer);
    }

    async terminate(): Promise<void> {
        log.debug('precompile', () => `terminating ${this.workers.length} workers`);
        await Promise.all(this.workers.map(w => w.terminate()));
        this.workers.length = 0;
    }
}
