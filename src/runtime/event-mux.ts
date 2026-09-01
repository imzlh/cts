/**
 * Process-wide owner of engine.onEvent's single native receiver.
 *
 * The `Symbol.for()` registry keeps baked and disk-loaded CTS copies on one
 * bus. Native return polarity differs by event: `false` continues an
 * unhandled rejection but stops a job exception, and only `true` cancels
 * beforeunload. Do not normalize those return values.
 */

const engine = import.meta.use('engine');

/** Native event ids. Read from the engine enum, with the C values as fallback. */
export const EV = {
    UNHANDLED_REJECTION: numericEvent('UNHANDLED_REJECTION', 0),
    JOB_EXCEPTION: numericEvent('JOB_EXCEPTION', 1),
    EXIT: numericEvent('EXIT', 2),
    LOAD: numericEvent('LOAD', 3),
    BEFORE_UNLOAD: numericEvent('BEFORE_UNLOAD', 4),
    /* Node's 'beforeExit'. vm.c dispatches it from tjs__lifecycle_drain() before
     * BEFORE_UNLOAD and re-dispatches while a listener keeps queueing work. */
    BEFORE_EXIT: numericEvent('BEFORE_EXIT', 5),
} as const;

function numericEvent(name: string, fallback: number): number {
    try {
        const v = (engine.EventType as unknown as Record<string, unknown>)?.[name];
        return typeof v === 'number' ? v : fallback;
    } catch {
        return fallback;
    }
}

/** Per-dispatch state shared by all receivers for one native event. */
export interface EventContext {
    /** User code cancelled the default action (`preventDefault()`). */
    handled: boolean;
    /** Someone already dispatched this event to the global EventTarget. */
    dispatched: boolean;
    /** Avoid duplicate Node rejection delivery without importing node/. */
    rejectionEmitted?: boolean;
}

/**
 * A receiver. Return `undefined` for "no opinion on the native return value";
 * the last receiver that returns an explicit boolean decides it.
 */
export type EventReceiver = (name: number, data: unknown, ctx: EventContext) => boolean | undefined;

interface Entry {
    role: string;
    priority: number;
    seq: number;
    fn: EventReceiver;
}

export interface EventMux {
    readonly version: 1;
    /** Register a receiver. Returns an uninstall function. Replaces same-role. */
    install(role: string, fn: EventReceiver, priority?: number): () => void;
    /** Is a receiver with this role registered? */
    has(role: string): boolean;
    /** Registered roles, in dispatch order. */
    roles(): string[];
    /** Dispatch as the native receiver would. Exposed for tests. */
    dispatch(name: number, data: unknown): boolean;
}

interface MuxInternal extends EventMux {
    entries: Entry[];
    seq: number;
    native: boolean;
    dispatchDepth: number;
    /** Shared so separate CTS copies cannot each fire lifecycle events once. */
    loadFired: boolean;
    unloadFired: boolean;
}

const SLOT = Symbol.for('cno.engine.eventMux.v1');

/** Default native return per event, matching pre-mux behaviour exactly. */
function defaultReturn(name: number): boolean {
    if (name === EV.JOB_EXCEPTION) return true;   // false would TJS_Stop
    // Only `true` cancels BEFORE_UNLOAD, so its default must remain false.
    return false;                                  // rejection: false = do not abort
}

function createMux(): MuxInternal {
    const mux: MuxInternal = {
        version: 1,
        entries: [],
        seq: 0,
        native: false,
        dispatchDepth: 0,
        loadFired: false,
        unloadFired: false,

        install(role: string, fn: EventReceiver, priority = 0): () => void {
            // Same-role re-install replaces rather than stacks, so a module that
            // is evaluated twice cannot double-dispatch.
            const existing = mux.entries.findIndex((e) => e.role === role);
            if (existing !== -1) mux.entries.splice(existing, 1);

            const entry: Entry = { role, priority, seq: mux.seq++, fn };
            mux.entries.push(entry);
            // Higher priority first; ties keep registration order.
            mux.entries.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));

            ensureNative(mux);

            return () => {
                const i = mux.entries.indexOf(entry);
                if (i !== -1) mux.entries.splice(i, 1);
            };
        },

        has(role: string): boolean {
            return mux.entries.some((e) => e.role === role);
        },

        roles(): string[] {
            return mux.entries.map((e) => e.role);
        },

        dispatch(name: number, data: unknown): boolean {
            mux.dispatchDepth++;
            try {
                const ctx: EventContext = { handled: false, dispatched: false, rejectionEmitted: false };
                let ret: boolean | undefined;

                // Snapshot: a receiver may install/uninstall during dispatch.
                for (const entry of mux.entries.slice()) {
                    let r: boolean | undefined;
                    try {
                        r = entry.fn(name, data, ctx);
                    } catch (e) {
                        // Let native lifecycle handling observe listener failures.
                        if (name === EV.BEFORE_UNLOAD || name === EV.BEFORE_EXIT) throw e;
                        continue;
                    }
                    if (typeof r === 'boolean') {
                        // beforeunload cancellation is sticky; other events are last-wins.
                        if (name === EV.BEFORE_UNLOAD) ret = ret === true || r;
                        else ret = r;
                    }
                }

                return typeof ret === 'boolean' ? ret : defaultReturn(name);
            } finally {
                mux.dispatchDepth--;
            }
        },
    };

    return mux;
}

function ensureNative(mux: MuxInternal, reassert = false): void {
    if (mux.dispatchDepth > 0 || (mux.native && !reassert)) return;
    try {
        engine.onEvent((name: number, data: unknown) => mux.dispatch(name, data));
        mux.native = true;
    } catch {
        // Sandboxed contexts reject onEvent (CHECK_IF_IN_SANDBOX). Receivers stay
        // registered so an in-process dispatch() still works.
    }
}

/** The process-wide mux, created on first use. */
export function getEventMux(): EventMux {
    const g = globalThis as unknown as Record<symbol, MuxInternal | undefined>;
    let mux = g[SLOT];
    if (!mux || mux.version !== 1) {
        mux = createMux();
        g[SLOT] = mux;
    } else {
        // A prior instance may have lost the native slot to a direct
        // engine.onEvent() call by some other module; re-assert it.
        ensureNative(mux, true);
    }
    return mux;
}

/** Convenience wrapper: `installEventReceiver('role', fn, priority)`. */
export function installEventReceiver(
    role: string,
    fn: EventReceiver,
    priority = 0,
): () => void {
    return getEventMux().install(role, fn, priority);
}

/* ------------------------------------------------------------------ *
 * Global EventTarget bridge
 * ------------------------------------------------------------------ */

/** Role used by cno/src/webapi/index.ts once it registers through the mux. */
export const WEBAPI_ROLE = 'webapi';
/** Role of the compatibility bridge below. */
export const WEBAPI_COMPAT_ROLE = 'webapi-compat';
/** Role of the node `process` bridge in cno/src/node/process/mod.ts. */
export const NODE_PROCESS_ROLE = 'node-process';
/** Role of the `unhandledRejection` -> `process` bridge below. */
export const NODE_PROCESS_REJECTION_ROLE = 'node-process-rejection';

/** Priority band: user-visible dispatch must run before diagnostics. */
export const PRIORITY_WEBAPI = 100;
/** Between webapi and diagnostics. */
export const PRIORITY_NODE_PROCESS = 50;
export const PRIORITY_DIAGNOSTICS = 0;
/** Runs last; its explicit return value wins for non-beforeunload events. */
export const PRIORITY_FALLBACK = -100;

function globalCtor(name: string): (new (...args: never[]) => unknown) | null {
    const c = (globalThis as unknown as Record<string, unknown>)[name];
    return typeof c === 'function' ? (c as new (...args: never[]) => unknown) : null;
}

function dispatchGlobal(event: unknown): boolean {
    const dispatchEvent = (globalThis as unknown as {
        dispatchEvent?: (e: unknown) => boolean;
    }).dispatchEvent;
    if (typeof dispatchEvent !== 'function') return false;
    try {
        dispatchEvent.call(globalThis, event);
        return true;
    } catch {
        return false;
    }
}

function wasPrevented(event: unknown): boolean {
    return !!(event as { defaultPrevented?: boolean } | null)?.defaultPrevented;
}

/** beforeunload listener errors must reach native lifecycle handling. */
function dispatchGlobalPropagating(event: unknown): boolean {
    const dispatchEvent = (globalThis as unknown as {
        dispatchEvent?: (e: unknown) => boolean;
    }).dispatchEvent;
    if (typeof dispatchEvent !== 'function') return false;
    dispatchEvent.call(globalThis, event);
    return true;
}

/** Fallback until webapi registers; role and context prevent double dispatch. */
export function installWebApiCompatBridge(): () => void {
    return installEventReceiver(WEBAPI_COMPAT_ROLE, (name, data, ctx) => {
        // webapi itself is on the bus: it owns the dispatch.
        if (getEventMux().has(WEBAPI_ROLE)) return undefined;
        if (ctx.dispatched) return undefined;

        if (name === EV.UNHANDLED_REJECTION) {
            const PRE = globalCtor('PromiseRejectionEvent');
            if (!PRE) return undefined;
            const [promise, reason] = Array.isArray(data) ? data : [undefined, data];
            let event: unknown;
            try {
                event = new (PRE as new (t: string, i: unknown, trust?: boolean) => unknown)(
                    'unhandledrejection',
                    { promise, reason, cancelable: true },
                    true,
                );
            } catch {
                return undefined;
            }
            if (!dispatchGlobal(event)) return undefined;
            ctx.dispatched = true;
            if (wasPrevented(event)) ctx.handled = true;
            return undefined;
        }

        if (name === EV.BEFORE_UNLOAD) {
            const Ev = globalCtor('Event');
            if (!Ev) return undefined;
            let event: unknown;
            try {
                event = new (Ev as new (t: string, i?: unknown) => unknown)(
                    'beforeunload',
                    { cancelable: true },
                );
            } catch {
                return undefined;
            }
            // A beforeunload listener error is fatal, unlike other event errors.
            if (!dispatchGlobalPropagating(event)) return undefined;
            // EXIT must still emit unload, so this event does not set dispatched.
            return wasPrevented(event) ? true : false;
        }

        if (name === EV.EXIT) {
            const Ev = globalCtor('Event');
            if (!Ev) return undefined;
            try {
                dispatchGlobal(new (Ev as new (t: string) => unknown)('unload'));
                dispatchGlobal(new (Ev as new (t: string) => unknown)('exit'));
            } catch {
                return undefined;
            }
            ctx.dispatched = true;
            return undefined;
        }

        if (name === EV.LOAD) {
            const Ev = globalCtor('Event');
            if (!Ev) return undefined;
            try {
                dispatchGlobal(new (Ev as new (t: string) => unknown)('load'));
            } catch {
                return undefined;
            }
            ctx.dispatched = true;
            return undefined;
        }

        return undefined;
    }, PRIORITY_WEBAPI);
}

/** Role of the internal lifecycle once-guard. Exported for tests. */
export const LIFECYCLE_GUARD_ROLE = 'lifecycle-guard';

/* ------------------------------------------------------------------ *
 * EV_UNHANDLED_REJECTION -> process 'unhandledRejection'
 * ------------------------------------------------------------------ */

/** Node modules cannot import CTS after cache installation, so use a slot. */
const PROCESS_SLOT = Symbol.for('cno.node.process.default');

interface ProcessEmitterLike {
    emit(event: string, ...args: unknown[]): boolean;
    listenerCount(event: string): number;
}

function processEmitter(): ProcessEmitterLike | null {
    try {
        const p = (globalThis as unknown as Record<symbol, unknown>)[PROCESS_SLOT];
        if (!p || (typeof p !== 'object' && typeof p !== 'function')) return null;
        const cand = p as ProcessEmitterLike;
        if (typeof cand.emit !== 'function' || typeof cand.listenerCount !== 'function') return null;
        return cand;
    } catch {
        // Exotic global; treat as absent.
        return null;
    }
}

/**
 * Bridge rejections to process when a handler exists. For this native event,
 * `false` means continue (opposite JOB_EXCEPTION); never return `true`.
 */
export function installNodeProcessRejectionBridge(): () => void {
    return installEventReceiver(NODE_PROCESS_REJECTION_ROLE, (name, data, ctx) => {
        if (name !== EV.UNHANDLED_REJECTION) return undefined;

        const proc = processEmitter();
        if (!proc) return undefined;

        // Roles may register in either order; never emit the same rejection twice.
        if (getEventMux().has(NODE_PROCESS_ROLE) && ctx.rejectionEmitted) return undefined;

        const [promise, reason] = Array.isArray(data) ? data : [undefined, data];

        // Without a handler, leave diagnostics and native handling untouched.
        if (proc.listenerCount('unhandledRejection') === 0) return undefined;

        ctx.rejectionEmitted = true;
        try {
            proc.emit('unhandledRejection', reason, promise);
        } catch { /* handler errors are not native aborts */ }

        ctx.handled = true;
        return false;
    }, PRIORITY_NODE_PROCESS);
}

/** Record native exit so synthetic unload remains exactly-once. */
function ensureLifecycleGuard(mux: MuxInternal): void {
    // The registry check lets tests remove and reinstall the guard.
    if (mux.has(LIFECYCLE_GUARD_ROLE)) return;
    mux.install(LIFECYCLE_GUARD_ROLE, (name) => {
        if (name === EV.EXIT) mux.unloadFired = true;
        // Native EV_LOAD precedes user entry, so it must not satisfy this guard.
        return undefined;
    }, PRIORITY_FALLBACK);
}

function internalMux(): MuxInternal {
    return getEventMux() as MuxInternal;
}

/** Has the user-visible 'load' event already been fired? */
export function loadEventFired(): boolean {
    return internalMux().loadFired;
}

/** Has the user-visible 'unload' event already been fired (or EV_EXIT seen)? */
export function unloadEventFired(): boolean {
    return internalMux().unloadFired;
}

/** Test-only reset for lifecycle once-flags. */
export function resetLifecycleFlagsForTest(): void {
    const mux = internalMux();
    mux.loadFired = false;
    mux.unloadFired = false;
}

/** Fire the user-visible load event once after entry evaluation. */
export function dispatchLoadEvent(): boolean {
    const mux = internalMux();
    ensureLifecycleGuard(mux);
    if (mux.loadFired) return false;
    const Ev = globalCtor('Event');
    if (!Ev) return false;
    // Set before dispatch so a throwing listener cannot enable a second event.
    mux.loadFired = true;
    try {
        return dispatchGlobal(new (Ev as new (t: string) => unknown)('load'));
    } catch {
        return false;
    }
}

/** Fire unload once unless native exit already did. */
export function dispatchUnloadEvent(): boolean {
    const mux = internalMux();
    ensureLifecycleGuard(mux);
    if (mux.unloadFired) return false;
    const Ev = globalCtor('Event');
    if (!Ev) return false;
    mux.unloadFired = true;
    try {
        return dispatchGlobal(new (Ev as new (t: string) => unknown)('unload'));
    } catch {
        return false;
    }
}
