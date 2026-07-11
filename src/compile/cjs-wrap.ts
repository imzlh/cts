// Shared CJS wrapper-source construction, used both at run time (CjsLoader's
// fallback compile in cjs.ts) and at precompile time (parse.ts) so the exact
// same source shape is compiled either way — required for the precompiled
// bytecode cache to be interchangeable with a fresh compile.
//
// The wrapper is compiled with EVAL_GLOBAL (sloppy mode, matching Node's own
// CJS wrapper semantics) + EVAL_COMPILE_ONLY, never as an engine.Module —
// module code is unconditionally strict per spec, which would silently
// change CJS semantics (implicit globals, `this`, etc). See engine.d.ts's
// EVAL_COMPILE_ONLY / evalCompiled().
//
// The five CJS locals are read from a single well-known global slot instead
// of being closed over, so the compiled bytecode has no per-invocation state
// baked in — the caller overwrites the slot immediately before every
// evalCompiled() call. Safe for synchronous re-entrancy (nested require()):
// the wrapper's `.call(...)` argument list is evaluated synchronously as the
// very first thing the compiled code does, before any user code runs, so a
// nested invocation overwriting the slot afterward can't affect an
// already-captured outer call.
const CTX_SLOT = 'globalThis[Symbol.for("cts.cjs.ctx")]';

export interface CjsContext {
    exports: unknown;
    require: unknown;
    module: unknown;
    __filename: string;
    __dirname: string;
}

export function cjsContextSlot(): symbol {
    return Symbol.for('cts.cjs.ctx');
}

export function buildCjsWrapperSource(src: string): string {
    return `(function(exports,require,module,__filename,__dirname){${src}\n})` +
        `.call(${CTX_SLOT}.exports,` +
        `${CTX_SLOT}.exports,` +
        `${CTX_SLOT}.require,` +
        `${CTX_SLOT}.module,` +
        `${CTX_SLOT}.__filename,` +
        `${CTX_SLOT}.__dirname);`;
}
