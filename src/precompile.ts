// precompile.ts — Worker-parallel Sucrase transform + main-thread QJS compile
//
// Phase 1 (Worker-parallel): N workers do Sucrase transform (string→string)
// Phase 2 (main-thread):    QJS new Module + dump → bytecode (C layer, fast)
//
// This avoids: Worker needing resolver, duplicate module compilation, memory bloat.

import { Transformer } from './transformer';
import { readText } from './utils/io';
import { errMsg } from './utils/misc';
import { log } from './utils/log';
import { worker, engine, os, fs, timers } from './utils';

// ---------------------------------------------------------------------------
// Worker protocol — only Sucrase transform, no QJS
// ---------------------------------------------------------------------------

interface TransformTask {
    id: number;
    localPath: string;
    source: string;
}

interface TransformResult {
    id: number;
    localPath: string;
    code?: string;
    error?: string;
}

// ---------------------------------------------------------------------------
// In-worker: Sucrase only
// ---------------------------------------------------------------------------

export function isCompilerWorker(): boolean {
    return worker.isWorker && (worker.workerData as any)?.__cts_role === 'compiler';
}

export async function runCompilerWorker(): Promise<void> {
    const pipe = worker.pipe!;
    const transformer = new Transformer(false);

    pipe.onmessage = (raw: any) => {
        const task = raw as TransformTask;
        if (task?.id === undefined) return;

        try {
            const code = transformer.transform(task.source, task.localPath);
            pipe.postMessage({ id: task.id, localPath: task.localPath, code } as TransformResult);
        } catch (e) {
            pipe.postMessage({ id: task.id, localPath: task.localPath, error: errMsg(e) } as TransformResult);
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

    constructor(idx: number, onResult: (r: TransformResult) => void) {
        this.idx = idx;
        this.w = new worker.Worker({ __cts_role: 'compiler' });
        this.pipe = this.w.messagePipe;
        this.pipe.onmessage = (data: any) => {
            this.busy = false;
            onResult(data as TransformResult);
        };
    }

    send(task: TransformTask): void {
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
    private pending: TransformTask[] = [];
    private results = new Map<number, TransformResult>();
    private nextId = 0;
    private maxWorkers: number;

    constructor() {
        try {
            const n = os.getenv('CTS_WORKERS');
            if (n) this.maxWorkers = Math.max(1, Math.min(+n, 16));
            else this.maxWorkers = 4;
        } catch { this.maxWorkers = 4; }
    }

    async precompile(
        modules: Array<{ specPath: string; localPath: string }>,
        onProgress?: (done: number, total: number) => void,
    ): Promise<Map<string, ArrayBuffer>> {
        if (!modules.length) return new Map();

        const bytecodes = new Map<string, ArrayBuffer>();
        const total = modules.length;

        // Phase 1: read sources + dispatch to workers for Sucrase transform
        log.debug('precompile', () => `reading ${total} sources`);

        const tasks: TransformTask[] = [];
        const specMap = new Map<number, string>(); // id → specPath
        for (const m of modules) {
            let source: string;
            try { source = readText(m.localPath); }
            catch (e) {
                log.debug('precompile', () => `read fail: ${m.localPath}: ${errMsg(e)}`);
                continue;
            }
            const id = this.nextId++;
            tasks.push({ id, localPath: m.localPath, source });
            specMap.set(id, m.specPath);
        }

        if (!tasks.length) return bytecodes;
        const taskTotal = tasks.length;
        let transformDone = 0;
        let transformFail = 0;

        const ensureWorkers = (n: number) => {
            while (this.workers.length < n) {
                const w = new TxWorker(this.workers.length, (r) => {
                    this.results.set(r.id, r);
                    if (r.code) transformDone++;
                    else { transformFail++; log.debug('precompile', () => `transform fail: ${r.localPath}: ${r.error}`); }
                    onProgress?.(transformDone + transformFail, taskTotal);
                    this.drain();
                });
                this.workers.push(w);
                log.debug('precompile', () => `spawned worker ${w.idx}`);
            }
        };

        // Create all workers upfront to avoid progressive scaling delay
        ensureWorkers(this.maxWorkers);
        this.pending = tasks;
        this.drain();

        // Wait for all transforms
        await new Promise<void>((resolve) => {
            const check = () => {
                if (transformDone + transformFail >= taskTotal) {
                    resolve();
                } else {
                    timers.setTimeout(check, 10);
                }
            };
            check();
        });

        log.debug('precompile', () => `transforms: ${transformDone} ok, ${transformFail} fail`);

        // Phase 2: QJS compile on main thread (C layer, fast, needs resolver context)
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
            onProgress?.(taskTotal + compileDone, taskTotal * 2);
        }

        log.debug('precompile', () => `compiled ${bytecodes.size}/${taskTotal} (${this.workers.length} workers)`);
        return bytecodes;
    }

    private drain(): void {
        while (this.pending.length > 0) {
            const idle = this.workers.find(w => !w.busy);
            if (!idle) break;
            idle.send(this.pending.shift()!);
        }
    }

    async terminate(): Promise<void> {
        log.debug('precompile', () => `terminating ${this.workers.length} workers`);
        await Promise.all(this.workers.map(w => w.terminate()));
        this.workers.length = 0;
    }
}
