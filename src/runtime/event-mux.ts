// Each receiver owns a native runtime-event subscription. The realm-local
// facade only retains role replacement, introspection, and lifecycle state.
// Return polarity differs per event — do not normalize it.

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
    unsubscribe: () => void;
}

export interface EventMux {
    readonly version: 1;
    /** Register a receiver. Returns an uninstall function. Replaces same-role. */
    install(role: string, fn: EventReceiver, priority?: number): () => void;
    /** Is a receiver with this role registered? */
    has(role: string): boolean;
    /** Registered roles, in dispatch order. */
    roles(): string[];
    /** Dispatch through the native runtime-event channel. Exposed for tests. */
    dispatch(name: number, data: unknown): boolean;
}

interface MuxInternal extends EventMux {
    readonly backend: 'runtime-evbus';
    entries: Entry[];
    seq: number;
    /** Shared by CTS copies in this realm, not by other realms. */
    loadFired: boolean;
    unloadFired: boolean;
}

const SLOT = Symbol.for('cno.engine.eventMux.v1');

interface RuntimeEventFrame {
    name: number;
    data: unknown;
    context: EventContext;
}

interface RuntimeEventBus {
    readonly RUNTIME_NAMESPACE: string;
    readonly RUNTIME_EVENT: string;
    on<T>(
        namespace: string,
        event: string,
        listener: (frame: T) => boolean | undefined,
        priority?: number,
    ): () => void;
    dispatchRuntimeEvent(name: number, data: unknown): boolean | undefined;
}

const evbus = import.meta.use('evbus') as unknown as RuntimeEventBus;

/** Default native return per event, matching pre-mux behaviour exactly.
 *  `true` is the only value that cancels BEFORE_UNLOAD and the only one that
 *  errs a JOB_EXCEPTION; rejections need `false` to continue. */
function defaultReturn(name: number): boolean {
    return name === EV.JOB_EXCEPTION;
}

function invokeReceiver(fn: EventReceiver, frame: RuntimeEventFrame): boolean | undefined {
    try {
        return fn(frame.name, frame.data, frame.context);
    } catch (e) {
        // Let native lifecycle handling observe listener failures. Other engine
        // event listeners remain isolated, matching the previous facade.
        if (frame.name === EV.BEFORE_UNLOAD || frame.name === EV.BEFORE_EXIT) throw e;
        return undefined;
    }
}

function createMux(): MuxInternal {
    const mux: MuxInternal = {
        version: 1,
        backend: 'runtime-evbus',
        entries: [],
        seq: 0,
        loadFired: false,
        unloadFired: false,

        install(role: string, fn: EventReceiver, priority = 0): () => void {
            // Same-role re-install replaces rather than stacks, so a module that
            // is evaluated twice cannot double-dispatch.
            const existing = mux.entries.find((entry) => entry.role === role);
            existing?.unsubscribe();

            let active = true;
            let entry: Entry | undefined;
            const offNative = evbus.on<RuntimeEventFrame>(
                evbus.RUNTIME_NAMESPACE,
                evbus.RUNTIME_EVENT,
                (frame) => invokeReceiver(fn, frame),
                priority,
            );
            entry = {
                role,
                priority,
                seq: mux.seq++,
                unsubscribe: () => {
                    if (!active) return;
                    active = false;
                    const index = entry ? mux.entries.indexOf(entry) : -1;
                    if (index !== -1) mux.entries.splice(index, 1);
                    offNative();
                },
            };
            mux.entries.push(entry);
            // Higher priority first; ties keep registration order.
            mux.entries.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
            return entry.unsubscribe;
        },

        has(role: string): boolean {
            return mux.entries.some((e) => e.role === role);
        },

        roles(): string[] {
            return mux.entries.map((e) => e.role);
        },

        dispatch(name: number, data: unknown): boolean {
            const result = evbus.dispatchRuntimeEvent(name, data);
            return typeof result === 'boolean' ? result : defaultReturn(name);
        },
    };
    return mux;
}

/** The realm-local mux, created on first use. */
export function getEventMux(): EventMux {
    const g = globalThis as unknown as Record<symbol, MuxInternal | undefined>;
    let mux = g[SLOT];
    if (!mux || mux.version !== 1 || mux.backend !== 'runtime-evbus') {
        mux = createMux();
        g[SLOT] = mux;
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

function inWorker(): boolean {
    return Reflect.get(globalThis, 'isWorker') === true;
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
            if (inWorker()) return undefined;
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
            // The context is per native dispatch, so this only suppresses a
            // second beforeunload bridge; a later EXIT still emits unload.
            ctx.dispatched = true;
            if (wasPrevented(event)) {
                ctx.handled = true;
                return true;
            }
            return false;
        }

        if (name === EV.EXIT) {
            const Ev = globalCtor('Event');
            if (!Ev) return undefined;
            try {
                if (!inWorker()) dispatchGlobal(new (Ev as new (t: string) => unknown)('unload'));
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
 *
 * Owned by cno/src/node/process/mod.ts, which subscribes directly to evbus
 * when the node process module installs. CTS must not discover node objects,
 * so there is no CTS-side rejection bridge; the shared `rejectionEmitted`
 * context field remains available to any additional bridge.
 * ------------------------------------------------------------------ */

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
    if (inWorker()) return false;
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
