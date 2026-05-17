// wasm.ts — WASM module loading with import resolution
//
// Resolves WASM imports through the JS module system (like V8/Deno):
//   import { floor } from "env"  →  Math.floor
//   import { __wbindgen_add_heap_index } from "./bg.js"  →  real JS function
//
// Unresolved imports throw LinkError (V8/Deno compatible behavior).
// WASI imports (wasi_unstable / wasi_snapshot_preview1) are handled by
// setWasiOptions and skipped during manual resolution.

import type { ModuleInfo } from './types';
import { errMsg } from './utils/misc';
import { log } from './utils/log';
import { fs, engine, wasm, assert } from './utils/index';

const RE_INT_LITERAL = /^-?\d+n?$/;

// ---------------------------------------------------------------------------
// Error classes — V8/Deno WebAssembly API compatibility
// ---------------------------------------------------------------------------

export class CompileError extends Error {
    constructor(message: string) { super(message); this.name = 'CompileError'; }
}

export class LinkError extends Error {
    constructor(message: string) { super(message); this.name = 'LinkError'; }
}

export class RuntimeError extends Error {
    constructor(message: string) { super(message); this.name = 'RuntimeError'; }
}

// ---------------------------------------------------------------------------
// Built-in "env" module — standard WASM env imports (Math, etc.)
// ---------------------------------------------------------------------------

const ENV_MODULE: Record<string, Function> = {
    floor:   Math.floor,
    ceil:    Math.ceil,
    trunc:   Math.trunc,
    round:   Math.round,
    abs:     Math.abs,
    sqrt:    Math.sqrt,
    fmod:    (a: number, b: number) => a % b,
    pow:     Math.pow,
    exp:     Math.exp,
    log:     Math.log,
    sin:     Math.sin,
    cos:     Math.cos,
    tan:     Math.tan,
    min_f32: Math.fround,
    max_f32: Math.fround,
    memory:  () => 0,
};

// WASI module names — handled by setWasiOptions, skip in manual resolution
const WASI_MODULES = new Set(['wasi_unstable', 'wasi_snapshot_preview1']);

// ---------------------------------------------------------------------------
// Import resolver
// ---------------------------------------------------------------------------

export interface WasmImportSource {
    /** Resolve a JS module by specifier + parentPath. Return its exports object. */
    require(spec: string, parentPath: string): Record<string, any> | null;
}

/**
 * Look up a named export, falling back to `exports.default[name]`.
 *
 * This handles the common case where a wasm-bindgen glue module is authored as
 *   export default { __wbindgen_export_0: table, ... }
 * or loaded as CJS where `module.exports = { ... }` becomes `{ default: {...} }`.
 */
function getExport(exports: Record<string, any>, name: string): any {
    if (name in exports) return exports[name];
    const def = exports.default;
    if (def && typeof def === 'object' && name in def) return def[name];
    return undefined;
}

function resolveImportFunc(
    imp: CModuleWASM.ModuleImportDescriptor,
    parentPath: string,
    importSource: WasmImportSource,
): ((...args: CModuleWASM.WasmValue[]) => CModuleWASM.WasmValue | void) | null {
    assert(wasm, "WASM support not available in this build");
    const { module: modName, name: fnName } = imp;

    // 1. JS module resolution — treat modName as a specifier
    //    Covers: wasm-bindgen ("./foo_bg.js"), WASI, any JS import
    try {
        const exports = importSource.require(modName, parentPath);
        if (exports) {
            const fn = getExport(exports, fnName);
            if (typeof fn === 'function') return fn;
            if (fn !== undefined) return () => fn;
        }
    } catch (e) {
        log.debug('wasm', () => `import resolve "${modName}" failed: ${errMsg(e)}`);
    }

    // 2. Built-in "env" module (Math, etc.)
    if (modName === 'env') {
        const fn = ENV_MODULE[fnName];
        if (fn) return fn as any;
    }

    // 3. No resolution found — caller will throw LinkError (V8/Deno behavior)
    return null;
}

function resolveTableImport(
    imp: CModuleWASM.ModuleImportDescriptor,
    parentPath: string,
    importSource: WasmImportSource,
): CModuleWASM.TableImportDescriptor | null {
    assert(wasm, "WASM support not available in this build");
    const { module: modName, name: fieldName } = imp;
    try {
        const exports = importSource.require(modName, parentPath);
        if (exports) {
            const table = getExport(exports, fieldName);
            if (table && typeof table === 'object' && typeof table.length === 'number') {
                const element = (table as any).element === 'anyfunc' ? 'funcref' as const : 'externref' as const;
                log.debug('wasm', () => `table import "${modName}::${fieldName}" resolved (element=${element}, initial=${table.length})`);
                return { module: modName, name: fieldName, element, initial: table.length };
            }
            log.debug('wasm', () => `table import "${modName}::${fieldName}" not found in exports: keys=${JSON.stringify(Object.keys(exports))}`);
        }
    } catch (e) {
        log.debug('wasm', () => `table import "${modName}::${fieldName}" resolve failed: ${errMsg(e)}`);
    }
    return null;
}

function resolveMemoryImport(
    imp: CModuleWASM.ModuleImportDescriptor,
    parentPath: string,
    importSource: WasmImportSource,
): CModuleWASM.MemoryImportDescriptor | null {
    assert(wasm, "WASM support not available in this build");
    const { module: modName, name: fieldName } = imp;
    try {
        const exports = importSource.require(modName, parentPath);
        if (exports) {
            const mem = getExport(exports, fieldName);
            if (mem && typeof mem === 'object' && (mem as any).buffer instanceof ArrayBuffer) {
                const initial = Math.ceil(((mem as any).buffer as ArrayBuffer).byteLength / 65536);
                return { module: modName, name: fieldName, initial };
            }
        }
    } catch (e) {
        log.debug('wasm', () => `memory import "${modName}::${fieldName}" resolve failed: ${errMsg(e)}`);
    }
    return null;
}

function resolveGlobalImport(
    imp: CModuleWASM.ModuleImportDescriptor,
    parentPath: string,
    importSource: WasmImportSource,
): CModuleWASM.GlobalImportDescriptor | null {
    assert(wasm, "WASM support not available in this build");
    const { module: modName, name: fieldName } = imp;
    try {
        const exports = importSource.require(modName, parentPath);
        if (exports) {
            const g = getExport(exports, fieldName);
            if (g && typeof g === 'object') {
                const raw = (g as any).value ?? (typeof (g as any).valueOf === 'function' ? (g as any).valueOf() : 0);
                const vtype = typeof raw;
                const type = vtype === 'bigint' ? 'i64' as const
                    : vtype === 'number' ? (Number.isInteger(raw) ? 'i32' as const : 'f64' as const)
                    : 'i32' as const;
                return { module: modName, name: fieldName, value: raw as number | bigint, type, mutable: true };
            }
        }
    } catch (e) {
        log.debug('wasm', () => `global import "${modName}::${fieldName}" resolve failed: ${errMsg(e)}`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// WASM module builder
// ---------------------------------------------------------------------------

export function buildWasmModule(
    info: ModuleInfo,
    importSource: WasmImportSource,
): { mod: CModuleEngine.Module; instance: CModuleWASM.Instance } | null {
    if (!wasm) return null;

    const raw = fs.readFile(info.localPath);
    const wmod = wasm.parseModule(raw);

    // Resolve imports — throw LinkError on unresolved (V8/Deno behavior)
    const imports = wasm.moduleImports(wmod);
    if (imports.length > 0) {
        const funcDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
        const globalDescs: CModuleWASM.GlobalImportDescriptor[] = [];
        const tableDescs: CModuleWASM.TableImportDescriptor[] = [];
        const memoryDescs: CModuleWASM.MemoryImportDescriptor[] = [];

        for (const imp of imports) {
            // WASI imports are handled by setWasiOptions — skip manual resolution
            if (WASI_MODULES.has(imp.module)) continue;

            if (imp.kind === 'function') {
                const resolved = resolveImportFunc(imp, info.specPath, importSource);
                if (resolved) {
                    funcDescs.push({ module: imp.module, name: imp.name, func: resolved });
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (function)`,
                    );
                }
            } else if (imp.kind === 'global') {
                const resolved = resolveGlobalImport(imp, info.specPath, importSource);
                if (resolved) {
                    globalDescs.push(resolved);
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (global)`,
                    );
                }
            } else if (imp.kind === 'table') {
                const resolved = resolveTableImport(imp, info.specPath, importSource);
                if (resolved) {
                    tableDescs.push(resolved);
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (table)`,
                    );
                }
            } else if (imp.kind === 'memory') {
                const resolved = resolveMemoryImport(imp, info.specPath, importSource);
                if (resolved) {
                    memoryDescs.push(resolved);
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (memory)`,
                    );
                }
            }
        }

        if (funcDescs.length)  wasm.resolveImports(wmod, funcDescs);
        if (globalDescs.length) wasm.resolveGlobalImports(wmod, globalDescs);
        if (tableDescs.length)  wasm.resolveTableImports(wmod, tableDescs);
        if (memoryDescs.length) wasm.resolveMemoryImports(wmod, memoryDescs);
    }

    // WASI
    wasm.setWasiOptions(wmod, [], null, null);

    const inst = wasm.buildInstance(wmod);

    // -----------------------------------------------------------------------
    // Build ESM module with V8/Deno-compatible export wrappers
    //
    // Each export kind gets the standard WebAssembly.* prototype surface:
    //   Memory  → .buffer, .grow(), .type, [Symbol.toStringTag]
    //   Table   → .length, .get(), .set(), .grow(), .type, [Symbol.toStringTag]
    //   Global  → .value, .valueOf(), .type, [Symbol.toStringTag]
    //   Instance→ .exports, [Symbol.toStringTag]
    // -----------------------------------------------------------------------

    const exp = wasm.moduleExports(wmod);
    const mod = engine.Module.create(info.specPath);
    const ns: Record<string, any> = {};

    const wasm2 = wasm!;
    for (const e of exp) {
        switch (e.kind) {
            case 'function': {
                const fn = (...args: any[]): CModuleWASM.WasmValue | CModuleWASM.WasmValue[] => {
                    return inst.callFunction(e.name, ...args.map(a => toWasmValue(a)));
                };
                ns[e.name] = fn;
                mod.export(e.name, fn);
                break;
            }
            case 'memory': {
                const mem = {
                    get buffer(): ArrayBuffer { return wasm2.getMemoryBuffer(inst); },
                    grow(delta: number): number { return wasm2.growMemory(inst, delta); },
                    get type(): { minimum: number; maximum?: number } {
                        const buf = wasm2.getMemoryBuffer(inst);
                        return { minimum: Math.ceil(buf.byteLength / 65536) };
                    },
                };
                Object.defineProperty(mem, Symbol.toStringTag, { value: 'WebAssembly.Memory' });
                ns[e.name] = mem;
                mod.export(e.name, mem);
                break;
            }
            case 'table': {
                const tbl = {
                    get length(): number { return wasm2.tableSize(inst, e.name); },
                    get type(): { element: 'funcref' | 'externref'; minimum: number; maximum?: number } {
                        const info = wasm2.getTableInfo(inst, e.name);
                        const element = info.element === 'unknown'
                            ? 'funcref' as const
                            : info.element as 'funcref' | 'externref';
                        return {
                            element,
                            minimum: info.cur_size,
                            maximum: info.max_size > 0 ? info.max_size : undefined,
                        };
                    },
                    get(i: number): number | null { return wasm2.tableGet(inst, e.name, i) as number | null; },
                    set(i: number, v: number | null): void { wasm2.tableSet(inst, e.name, i, v); },
                    grow(d: number): number { return wasm2.tableGrow(inst, e.name, d); },
                };
                Object.defineProperty(tbl, Symbol.toStringTag, { value: 'WebAssembly.Table' });
                ns[e.name] = tbl;
                mod.export(e.name, tbl);
                break;
            }
            case 'global': {
                const gl = {
                    get value(): CModuleWASM.WasmValue { return wasm2.getGlobal(inst, e.name); },
                    set value(v: CModuleWASM.WasmValue) { wasm2.setGlobal(inst, e.name, v); },
                    valueOf(): CModuleWASM.WasmValue { return wasm2.getGlobal(inst, e.name); },
                    get type(): { value: 'i32' | 'i64' | 'f32' | 'f64'; mutable: boolean } {
                        const info = wasm2.getGlobalInfo(inst, e.name);
                        const vt = (info.type === 'externref' || info.type === 'funcref' || info.type === 'unknown')
                            ? 'i32' as const
                            : info.type;
                        return { value: vt, mutable: info.mutable };
                    },
                };
                Object.defineProperty(gl, Symbol.toStringTag, { value: 'WebAssembly.Global' });
                ns[e.name] = gl;
                mod.export(e.name, gl);
                break;
            }
        }
    }

    // Instance wrapper with .exports (V8/Deno compatibility)
    const wrappedInst: any = {
        callFunction: (name: string, ...args: CModuleWASM.WasmValue[]) =>
            inst.callFunction(name, ...args),
        exports: ns,
    };
    Object.defineProperty(wrappedInst, Symbol.toStringTag, { value: 'WebAssembly.Instance' });

    mod.export('default', ns);
    mod.export('instance', wrappedInst);

    log.debug('wasm', () => `loaded: ${exp.length} exports`);
    return { mod, instance: inst };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toWasmValue(v: unknown): CModuleWASM.WasmValue {
    if (typeof v === 'number')  return v;
    if (typeof v === 'bigint')  return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === undefined) return 0;
    if (typeof v === 'string') {
        const s = v as string;
        if (s === '') return 0;
        // Only convert strings that are explicitly integer literals (e.g. "123", "-5n").
        // Non-numeric strings cannot be meaningfully represented as a WASM value.
        if (RE_INT_LITERAL.test(s)) return BigInt(s.replace(/n$/, ''));
        return 0;
    }
    return 0;
}
