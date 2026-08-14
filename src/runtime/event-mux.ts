/**
 * Global engine-event multiplexer.
 *
 * `engine.onEvent()` (native `tjs__set_event_receiver`, circu.js/src/mod_engine.c:871)
 * is a SINGLE-SLOT setter: it frees the previously registered receiver. Every
 * module that called it directly therefore silently displaced the others. The
 * observed casualty was `cno/src/webapi/index.ts`, whose EV_LOAD/EV_EXIT ->
 * 'load'/'unload' bridge was overwritten by the cts diagnostics receiver, so
 * `addEventListener('unload'|'load'|'unhandledrejection')` registered fine and
 * never fired.
 *
 * This module owns the one native registration. Everything else registers here.
 *
 * Order independence: the registry lives on a `Symbol.for()` slot on
 * `globalThis`, not in module scope. Whichever module loads first creates it;
 * later modules find the same object. That also survives the case where two
 * *copies* of this file are live at once (cts is baked into cno.exe, but a
 * relative-path import of the same source loads a second instance from disk).
 *
 * Native return-value contract, per the C dispatch sites — the polarity is NOT
 * uniform, so the mux must not invent a single rule:
 *   EV_UNHANDLED_REJECTION (0)  vm.c:242    ret !== false  -> JS_EXCEPTION (abort)
 *   EV_JOB_EXCEPTION       (1)  utils.c:180 ret === false  -> TJS_Stop (fatal)
 *   EV_EXIT                (2)  return value freed, ignored
 *   EV_LOAD                (3)  return value freed, ignored
 *   EV_BEFORE_UNLOAD       (4)  vm.c:863    ret === JS_TRUE -> cancelled, re-dispatch
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

/**
 * Per-dispatch scratchpad shared by all receivers for one native event.
 *
 * This is how a user-facing receiver tells the diagnostics receiver to stay
 * quiet, without either one needing a reference to the other. It is the reason
 * `preventDefault()` on 'unhandledrejection' can suppress the "Uncaught"
 * warning even though the two live in different modules.
 */
export interface EventContext {
    /** User code cancelled the default action (`preventDefault()`). */
    handled: boolean;
    /** Someone already dispatched this event to the global EventTarget. */
    dispatched: boolean;
    /**
     * A receiver already emitted node's 'unhandledRejection' on `process`.
     *
     * Two receivers can own that emit — the bridge below, and a future rejection
     * arm in process/mod.ts under NODE_PROCESS_ROLE — and the user must not see
     * the handler fire twice. Optional so the existing `{handled, dispatched}`
     * literals in other modules (which cannot import this type across the node/
     * boundary) still satisfy the shape.
     */
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
    /**
     * Lifecycle once-flags. They live on the mux (a `Symbol.for()` global), not
     * in module scope, so the baked copy of this file and a disk-loaded copy
     * share them — otherwise each copy would fire 'load' once and the user would
     * see it twice.
     */
    loadFired: boolean;
    unloadFired: boolean;
}

const SLOT = Symbol.for('cno.engine.eventMux.v1');

/** Default native return per event, matching pre-mux behaviour exactly. */
function defaultReturn(name: number): boolean {
    if (name === EV.JOB_EXCEPTION) return true;   // false would TJS_Stop
    // EV_BEFORE_UNLOAD deliberately falls here too. vm.c:863 treats ONLY an
    // explicit JS `true` as "cancelled, give the loop another pass", so `false`
    // means "proceed with teardown" — the safe default. Returning `true` here
    // instead would make every natural drain re-dispatch forever and NO run
    // would ever exit; the C comment at vm.c:828-839 picked its polarity around
    // this exact value. Do not change it without changing vm.c in the same
    // commit.
    return false;                                  // rejection: false = do not abort
}

function createMux(): MuxInternal {
    const mux: MuxInternal = {
        version: 1,
        entries: [],
        seq: 0,
        native: false,
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
            const ctx: EventContext = { handled: false, dispatched: false, rejectionEmitted: false };
            let ret: boolean | undefined;

            // Snapshot: a receiver may install/uninstall during dispatch.
            for (const entry of mux.entries.slice()) {
                let r: boolean | undefined;
                try {
                    r = entry.fn(name, data, ctx);
                } catch (e) {
                    // EV_BEFORE_UNLOAD is the one event whose thrown exception is
                    // part of the contract rather than a receiver bug to contain.
                    //
                    // Deno 2.9.3: a throwing 'beforeunload' listener is an
                    // uncaught error — rc=1, later listeners skipped, 'unload'
                    // never fires (OBSERVED). The C already implements exactly
                    // that, but only if it SEES the exception: vm.c:852 checks
                    // JS_IsException(bu), dumps, forces exit_code 1, sets
                    // unload_dispatched and stops looping. Swallowing here made
                    // JS_IsException unreachable, so the throw vanished and the
                    // run exited 0.
                    //
                    // Deliberately narrow. For every other id, containment is
                    // still right: a broken diagnostics receiver must not become
                    // fatal, and must not change the native return value.
                    //
                    // BEFORE_EXIT joins it for the same reason: node reports a
                    // throwing 'beforeExit' listener as an uncaught error and
                    // exits 1 (OBSERVED v24.18.0), and the C implements that only
                    // if the exception reaches it — vm.c checks JS_IsException on
                    // the dispatch result, forces exit_code 1 and still fires
                    // 'exit'. Swallowing here would make the throw vanish and the
                    // run exit 0.
                    if (name === EV.BEFORE_UNLOAD || name === EV.BEFORE_EXIT) throw e;
                    continue;
                }
                if (typeof r === 'boolean') {
                    // EV_BEFORE_UNLOAD composes as a VETO, not last-writer-wins.
                    //
                    // "The last explicit boolean decides" is right for the abort
                    // /continue events, where one authority should have the final
                    // say. For a cancel probe it is wrong and silently so: the
                    // question is "did ANYONE cancel?", a disjunction. Under
                    // last-wins, a receiver that returns a boolean for an id it
                    // does not care about discards a user's preventDefault().
                    //
                    // OBSERVED, not hypothetical: with a cancelling receiver at
                    // priority 200 the cancel was dropped and teardown proceeded
                    // (`bu 1 | unload n=1`), while the identical receiver at -50
                    // re-dispatched correctly (`bu 1 | work 1 | bu 2 | unload
                    // n=2`). Bisecting the priority put the culprit at exactly 0
                    // — PRIORITY_DIAGNOSTICS, whose baked receiver returned
                    // `false` for every id it did not recognise. Sticky-OR makes
                    // the cancel independent of receiver order and of any other
                    // receiver's opinion.
                    if (name === EV.BEFORE_UNLOAD) ret = ret === true || r;
                    else ret = r;
                }
            }

            return typeof ret === 'boolean' ? ret : defaultReturn(name);
        },
    };

    return mux;
}

function ensureNative(mux: MuxInternal): void {
    if (mux.native) return;
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
        ensureNative(mux);
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
/**
 * Band for the node `process` bridges: below webapi so the web ErrorEvent still
 * dispatches first, above diagnostics so setting `ctx.handled` can suppress the
 * "Uncaught" warning. `process/mod.ts` installs at exactly this value.
 */
export const PRIORITY_NODE_PROCESS = 50;
export const PRIORITY_DIAGNOSTICS = 0;
/**
 * Below diagnostics. Entries are dispatched highest-priority-first and the
 * *last* explicit boolean wins the native return value, so a receiver in this
 * band has the final say on abort/continue. Used by the REPL, which must stay
 * alive no matter what any other receiver returns.
 */
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

/**
 * Dispatch without the try/catch, for EV_BEFORE_UNLOAD only.
 *
 * `dispatchGlobal` returning false on a throw is right for events whose listener
 * errors must not become fatal. 'beforeunload' is the opposite: Deno makes a
 * throwing listener an uncaught error (rc=1, no 'unload'), and the C reproduces
 * that only if the exception reaches it (vm.c:852). Swallowing here would exit 0.
 */
function dispatchGlobalPropagating(event: unknown): boolean {
    const dispatchEvent = (globalThis as unknown as {
        dispatchEvent?: (e: unknown) => boolean;
    }).dispatchEvent;
    if (typeof dispatchEvent !== 'function') return false;
    dispatchEvent.call(globalThis, event);
    return true;
}

/**
 * Bridges native events to the global EventTarget, so
 * `addEventListener('unload'|'unhandledrejection')` actually fires.
 *
 * This duplicates what `cno/src/webapi/index.ts` does, because that file is
 * baked into cno.exe and its receiver was already destroyed by the single-slot
 * setter before this code runs — there is no native getter, so the displaced
 * receiver cannot be recovered and chained to. It therefore has to be
 * reproduced here.
 *
 * Once webapi registers through the mux under `WEBAPI_ROLE`, this bridge steps
 * aside (both the role check and `ctx.dispatched` guard against double
 * dispatch), which is what keeps the two order-independent.
 */
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
            // Native polarity: false = do not abort. Keep cts's non-fatal
            // behaviour either way; `handled` only silences the diagnostic.
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
                // Could not even build the event: say nothing, so defaultReturn's
                // `false` lets teardown proceed. Never return `true` here — that
                // is the hang.
                return undefined;
            }
            // Not dispatchGlobal(): a throwing listener must propagate so the C
            // sees JS_EXCEPTION and reproduces Deno's rc=1/no-unload semantics.
            if (!dispatchGlobalPropagating(event)) return undefined;
            // NOT ctx.dispatched: that flag guards the 'unload'/'exit' pair from a
            // double dispatch, and EV_BEFORE_UNLOAD is a separate event that is
            // followed by EV_EXIT in the same teardown. Setting it here would make
            // the EXIT arm stand down and 'unload' would never fire.
            //
            // POLARITY: vm.c:863 cancels on an explicit `true` and nothing else.
            // Return the cancel decision only, so `return false` from a listener —
            // which does NOT cancel under Deno (OBSERVED) — cannot be mistaken for
            // one, and an uncancelled drain yields `false` and exits.
            return wasPrevented(event) ? true : false;
        }

        if (name === EV.EXIT) {
            const Ev = globalCtor('Event');
            if (!Ev) return undefined;
            try {
                // Deno fires only 'unload' for an explicit exit (measured).
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

/**
 * The `process` object published on a well-known slot by
 * cno/src/node/process/mod.ts (its PROCESS_DEFAULT_SINGLETON). Reached through
 * the slot rather than an import: cts must not import across the node/ boundary,
 * and node/ is copied to the polyfill cache dir where `../../../cts` does not
 * exist — the same reason process/mod.ts reaches the mux through a Symbol slot
 * instead of importing it.
 */
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
 * Bridge EV_UNHANDLED_REJECTION to `process.on('unhandledRejection')`.
 *
 * It was not bridged at all: the cts diagnostics receiver printed its warning
 * and nothing ever emitted on `process`, so a registered
 * `process.on('unhandledRejection')` handler never fired (Node fires it —
 * OBSERVED against v24.18.0: handler runs, reason and promise both delivered,
 * rc=0). `process/mod.ts` bridges EV_EXIT and EV_JOB_EXCEPTION under
 * NODE_PROCESS_ROLE but has no rejection arm, so this fills that gap from the
 * cts side under its own role.
 *
 * RETURN-VALUE POLARITY — inverted relative to job exceptions, and getting it
 * backwards is fatal rather than merely wrong:
 *   EV_UNHANDLED_REJECTION  vm.c:242  `!JS_IsEqual(ret, JS_FALSE)` -> JS_EXCEPTION
 *   EV_JOB_EXCEPTION        utils.c:180 `JS_IsEqual(ret, JS_FALSE)` -> TJS_Stop
 * So for a rejection, `false` means "handled, do not abort" and any other value
 * (including `true` and `undefined`) requests the abort — the exact opposite of
 * JOB_EXCEPTION, where `true` means continue. That inversion was already shipped
 * as a real bug once, in webapi's bridge, where a `preventDefault()` on
 * 'unhandledrejection' returned `true` and thereby asked for a process abort.
 *
 * This bridge returns `false` when it delivered to a handler, and `undefined`
 * when it did not — never `true`. `undefined` leaves defaultReturn(), which is
 * also `false` for this event, so the non-fatal behaviour is preserved either
 * way; the explicit `false` documents the claim.
 */
export function installNodeProcessRejectionBridge(): () => void {
    return installEventReceiver(NODE_PROCESS_REJECTION_ROLE, (name, data, ctx) => {
        if (name !== EV.UNHANDLED_REJECTION) return undefined;

        const proc = processEmitter();
        if (!proc) return undefined;

        // If process/mod.ts ever grows its own rejection arm under
        // NODE_PROCESS_ROLE, this bridge must stand down or the user sees the
        // handler fire twice. Checked at dispatch time, not install time, because
        // the roles register in either order.
        if (getEventMux().has(NODE_PROCESS_ROLE) && ctx.rejectionEmitted) return undefined;

        const [promise, reason] = Array.isArray(data) ? data : [undefined, data];

        // Node's monitor-style ordering: emit even with no handler is WRONG for
        // this event (there is no 'unhandledRejectionMonitor'), so count first.
        // Zero handlers must leave the outcome untouched, diagnostic included.
        if (proc.listenerCount('unhandledRejection') === 0) return undefined;

        ctx.rejectionEmitted = true;
        try {
            // Node's argument order is (reason, promise).
            proc.emit('unhandledRejection', reason, promise);
        } catch {
            // A throw from inside the handler must not become a native abort.
            // The mux would swallow it anyway (dispatch() try/catch), but that
            // path also discards this receiver's return value, which would let
            // defaultReturn() stand — harmless here since it is also `false`.
            // Catching locally keeps the claim below reachable and explicit.
        }

        // The program dealt with it: silence the cts "unhandled promise
        // rejection" diagnostic, matching Node (which prints nothing when a
        // handler is present — OBSERVED).
        ctx.handled = true;

        // POLARITY: false = "do not abort" for a rejection (vm.c:242 raises
        // JS_EXCEPTION on any non-false). Returning true here would kill the
        // process on precisely the rejections the program handled.
        return false;
    }, PRIORITY_NODE_PROCESS);
}

/**
 * Observe native EV_EXIT so an explicit dispatchUnloadEvent() afterwards is a
 * no-op.
 *
 * webapi's bridge fires 'unload' on EV_EXIT unconditionally and has no way to
 * consult a flag (it is baked and its receiver is verified). So instead of
 * trying to suppress it, the mux *records* that it happened. That keeps the
 * exactly-once property in the order that actually occurs: a test suite calling
 * Deno.exit() gets webapi's unload, and the explicit post-suite dispatch stands
 * down.
 *
 * Registered below diagnostics so it runs after webapi has dispatched, and
 * returns `undefined` throughout — it must never influence the native return.
 */
function ensureLifecycleGuard(mux: MuxInternal): void {
    // Keyed off the registry itself rather than a boolean, so it re-arms if the
    // bus is drained (which tests do) instead of being permanently absent.
    if (mux.has(LIFECYCLE_GUARD_ROLE)) return;
    mux.install(LIFECYCLE_GUARD_ROLE, (name) => {
        if (name === EV.EXIT) mux.unloadFired = true;
        // Native EV_LOAD is deliberately NOT recorded: it fires for cno's own
        // bootstrap module before any user entry exists (utils.c:469), so
        // treating it as "the load event already happened" would suppress the
        // only dispatch a user can actually observe.
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

/**
 * Clear the lifecycle once-flags.
 *
 * Test-only. The flags exist to make 'load'/'unload' fire at most once per
 * process, which by design cannot be undone in a real run — so a test that
 * asserts the once behaviour needs a way back to the initial state.
 */
export function resetLifecycleFlagsForTest(): void {
    const mux = internalMux();
    mux.loadFired = false;
    mux.unloadFired = false;
}

/**
 * Fire the global 'load' event. Idempotent: at most once per process.
 *
 * The native EV_LOAD is dispatched by TJS_EvalModuleContent (utils.c:469) for
 * the C-level main module, which is cno's own bootstrap — it happens before a
 * user entry exists, so a user's addEventListener('load') can never see it
 * (OBSERVED: a raw receiver installed at the top of a `cno run` entry logs
 * EV 0 and 2 but never 3). Deno fires 'load' after the *user* entry module
 * evaluates, so that has to be synthesised at the entry-eval point.
 *
 * Call sites: src/commands/run.ts (after the entry evaluates) and
 * cno/src/deno/index.ts startTest (before the suite runs). The once-guard is
 * what lets both call unconditionally — `cno test` goes through both.
 */
export function dispatchLoadEvent(): boolean {
    const mux = internalMux();
    ensureLifecycleGuard(mux);
    if (mux.loadFired) return false;
    const Ev = globalCtor('Event');
    if (!Ev) return false;
    // Set before dispatching: a listener that throws must not leave the flag
    // clear and permit a second dispatch.
    mux.loadFired = true;
    try {
        return dispatchGlobal(new (Ev as new (t: string) => unknown)('load'));
    } catch {
        return false;
    }
}

/**
 * Fire the global 'unload' event. Idempotent, and stands down if a native
 * EV_EXIT already drove webapi's own 'unload' dispatch.
 *
 * Deno fires 'unload' exactly once, after the suite under `deno test` and after
 * loop drain under `deno run` (both measured against 2.9.3).
 */
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
