/**
 * Runtime-event subscription facade.
 *
 * Every receiver subscribes directly to evbus' native runtime-event channel.
 * Native evbus owns cross-realm ordering, the per-dispatch shared context, and
 * return-value aggregation; CTS does not own a native receiver or run a central
 * JavaScript dispatch loop.
 *
 * A realm-local `Symbol.for()` facade preserves role replacement, introspection,
 * lifecycle flags, and identity across baked and disk-loaded CTS copies. The
 * unsubscribe returned by `install()` removes the native evbus subscription.
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
    /** Dispatch through the native runtime-event channel. Exposed for tests. */
    dispatch(name: number, data: unknown): boolean;
}
/** The realm-local facade, created on first use. */
export declare function getEventMux(): EventMux;
/** Convenience wrapper: `installEventReceiver('role', fn, priority)`. */
export declare function installEventReceiver(role: string, fn: EventReceiver, priority?: number): () => void;
/** Role used by cno/src/webapi/index.ts once it registers through the mux. */
export declare const WEBAPI_ROLE = "webapi";
/** Role of the compatibility bridge below. */
export declare const WEBAPI_COMPAT_ROLE = "webapi-compat";
/** Role of the node `process` bridge in cno/src/node/process/mod.ts. */
export declare const NODE_PROCESS_ROLE = "node-process";
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
 * Once webapi subscribes under `WEBAPI_ROLE`, this compatibility bridge steps
 * aside. The role check and shared `ctx.dispatched` guard keep registration
 * order irrelevant and prevent duplicate global dispatch.
 */
export declare function installWebApiCompatBridge(): () => void;
/** Role of the internal lifecycle once-guard. Exported for tests. */
export declare const LIFECYCLE_GUARD_ROLE = "lifecycle-guard";
/**
 * EV_UNHANDLED_REJECTION delivery to `process` belongs to
 * `cno/src/node/process/mod.ts`, which subscribes directly to evbus when the
 * node module installs (eagerly, at bootstrap). CTS never discovers node
 * objects.
 *
 * Return-value polarity for this event — inverted relative to job exceptions,
 * and getting it backwards is fatal rather than merely wrong:
 *   EV_UNHANDLED_REJECTION  vm.c:242  `!JS_IsEqual(ret, JS_FALSE)` -> JS_EXCEPTION
 *   EV_JOB_EXCEPTION        utils.c:180 `JS_IsEqual(ret, JS_FALSE)` -> TJS_Stop
 * So for a rejection, `false` means "handled, do not abort" and any other value
 * (including `true` and `undefined`) requests the abort — the exact opposite of
 * JOB_EXCEPTION, where `true` means continue. That inversion was already shipped
 * as a real bug once, in webapi's bridge, where a `preventDefault()` on
 * 'unhandledrejection' returned `true` and thereby asked for a process abort.
 */
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
