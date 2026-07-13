// CJS wrapper for runtime + precompile: EVAL_GLOBAL|COMPILE_ONLY, locals via global slot.
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
