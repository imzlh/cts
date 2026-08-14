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
/** Native event ids. Read from the engine enum, with the C values as fallback. */
export declare const EV: {
    readonly UNHANDLED_REJECTION: number;
    readonly JOB_EXCEPTION: number;
    readonly EXIT: number;
    readonly LOAD: number;
    readonly BEFORE_UNLOAD: number;
    readonly BEFORE_EXIT: number;
};
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
/** The process-wide mux, created on first use. */
export declare function getEventMux(): EventMux;
/** Convenience wrapper: `installEventReceiver('role', fn, priority)`. */
export declare function installEventReceiver(role: string, fn: EventReceiver, priority?: number): () => void;
/** Role used by cno/src/webapi/index.ts once it registers through the mux. */
export declare const WEBAPI_ROLE = "webapi";
/** Role of the compatibility bridge below. */
export declare const WEBAPI_COMPAT_ROLE = "webapi-compat";
/** Role of the node `process` bridge in cno/src/node/process/mod.ts. */
export declare const NODE_PROCESS_ROLE = "node-process";
/** Role of the `unhandledRejection` -> `process` bridge below. */
export declare const NODE_PROCESS_REJECTION_ROLE = "node-process-rejection";
/** Priority band: user-visible dispatch must run before diagnostics. */
export declare const PRIORITY_WEBAPI = 100;
/**
 * Band for the node `process` bridges: below webapi so the web ErrorEvent still
 * dispatches first, above diagnostics so setting `ctx.handled` can suppress the
 * "Uncaught" warning. `process/mod.ts` installs at exactly this value.
 */
export declare const PRIORITY_NODE_PROCESS = 50;
export declare const PRIORITY_DIAGNOSTICS = 0;
/**
 * Below diagnostics. Entries are dispatched highest-priority-first and the
 * *last* explicit boolean wins the native return value, so a receiver in this
 * band has the final say on abort/continue. Used by the REPL, which must stay
 * alive no matter what any other receiver returns.
 */
export declare const PRIORITY_FALLBACK = -100;
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
export declare function installWebApiCompatBridge(): () => void;
/** Role of the internal lifecycle once-guard. Exported for tests. */
export declare const LIFECYCLE_GUARD_ROLE = "lifecycle-guard";
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
export declare function installNodeProcessRejectionBridge(): () => void;
/** Has the user-visible 'load' event already been fired? */
export declare function loadEventFired(): boolean;
/** Has the user-visible 'unload' event already been fired (or EV_EXIT seen)? */
export declare function unloadEventFired(): boolean;
/**
 * Clear the lifecycle once-flags.
 *
 * Test-only. The flags exist to make 'load'/'unload' fire at most once per
 * process, which by design cannot be undone in a real run — so a test that
 * asserts the once behaviour needs a way back to the initial state.
 */
export declare function resetLifecycleFlagsForTest(): void;
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
export declare function dispatchLoadEvent(): boolean;
/**
 * Fire the global 'unload' event. Idempotent, and stands down if a native
 * EV_EXIT already drove webapi's own 'unload' dispatch.
 *
 * Deno fires 'unload' exactly once, after the suite under `deno test` and after
 * loop drain under `deno run` (both measured against 2.9.3).
 */
export declare function dispatchUnloadEvent(): boolean;
//# sourceMappingURL=event-mux.d.ts.map