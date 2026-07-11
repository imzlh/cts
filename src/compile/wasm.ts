import type { ModuleInfo } from '../types';
import { errMsg, log, assert } from '../utils';
import { err, ErrorKind } from '../errors';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const wasm = import.meta.use('wasm');

const RE_INT_LITERAL = /^-?\d+n?$/;
type WasmImportExports = Record<string, unknown>;
type WasmImportFunction = (...args: CModuleWASM.WasmValue[]) => CModuleWASM.WasmValue | void;

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
// Built-in "env" module + WASI module names
// ---------------------------------------------------------------------------

const ENV_MODULE: Record<string, (...args: number[]) => number> = {
    floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, round: Math.round,
    abs: Math.abs, sqrt: Math.sqrt, fmod: (a: number, b: number) => a % b,
    pow: Math.pow, exp: Math.exp, log: Math.log,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    min_f32: Math.fround, max_f32: Math.fround, memory: () => 0,
    now: Date.now,
    emscripten_get_now: () => globalThis.performance?.now?.() ?? Date.now(),
};

// WASI module names — handled by setWasiOptions, skip in manual resolution
const WASI_MODULES = new Set(['wasi_unstable', 'wasi_snapshot_preview1']);

// Heuristic match for "the env module": env, ./env.js, env.js
const RE_ENV_MODULE = /^(?:\.\/)?env(?:\.js)?$/;

// ---------------------------------------------------------------------------
// Import resolver
// ---------------------------------------------------------------------------

export interface WasmImportSource {
    require(spec: string, parentPath: string): WasmImportExports | null;
}

// Look up a named export, falling back to exports.default[name].
function getExport(exports: WasmImportExports, name: string): unknown {
    if (name in exports) return exports[name];
    const def = exports.default;
    if (def && typeof def === 'object' && name in def) return Reflect.get(def, name);
    return undefined;
}

function getObjectField(value: unknown, key: PropertyKey): unknown {
    return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function resolveImportFunc(
    imp: CModuleWASM.ModuleImportDescriptor,
    parentPath: string,
    importSource: WasmImportSource,
): ((...args: CModuleWASM.WasmValue[]) => CModuleWASM.WasmValue | void) | null {
    assert(wasm, "WASM support not available in this build");
    const { module: modName, name: fnName } = imp;

    let resolveErr: unknown = null;
    try {
        const exports = importSource.require(modName, parentPath);
        if (exports) {
            const fn = getExport(exports, fnName);
            if (typeof fn === 'function') return fn as WasmImportFunction;
            if (fn !== undefined) return () => toWasmValue(fn);
        }
    } catch (e) {
        resolveErr = e;
        const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : '';
        log.debug('wasm', () => `import resolve "${modName}" failed: ${errMsg(e)}\n${stack}`);
    }

    if (RE_ENV_MODULE.test(modName)) {
        const fn = ENV_MODULE[fnName];
        if (fn) return (...args) => fn(...args.map(Number));
    }

    if (resolveErr) {
        log.warn('wasm', () => `unresolved ${modName}::${fnName}: ${errMsg(resolveErr)}`);
    }
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
            const length = getObjectField(table, 'length');
            if (typeof length === 'number') {
                const element = getObjectField(table, 'element') === 'anyfunc' ? 'funcref' as const : 'externref' as const;
                log.debug('wasm', () => `table import "${modName}::${fieldName}" resolved (element=${element}, initial=${length})`);
                return { module: modName, name: fieldName, element, initial: length };
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
            const buffer = getObjectField(mem, 'buffer');
            if (buffer instanceof ArrayBuffer) {
                const initial = Math.ceil(buffer.byteLength / 65536);
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
                const value = getObjectField(g, 'value');
                const valueOf = getObjectField(g, 'valueOf');
                const raw = value ?? (typeof valueOf === 'function' ? Reflect.apply(valueOf, g, []) : 0);
                const vtype = typeof raw;
                if (vtype !== 'number' && vtype !== 'bigint') {
                    return { module: modName, name: fieldName, value: 0, type: 'i32' as const, mutable: true };
                }
                const type = vtype === 'bigint' ? 'i64' as const
                    : vtype === 'number' ? (Number.isInteger(raw) ? 'i32' as const : 'f64' as const)
                    : 'i32' as const;
                return { module: modName, name: fieldName, value: raw, type, mutable: true };
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

    const imports = wasm.moduleImports(wmod);
    if (imports.length > 0) {
        const funcDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
        const globalDescs: CModuleWASM.GlobalImportDescriptor[] = [];
        const tableDescs: CModuleWASM.TableImportDescriptor[] = [];
        const memoryDescs: CModuleWASM.MemoryImportDescriptor[] = [];

        for (const imp of imports) {
            if (WASI_MODULES.has(imp.module)) continue;

            if (imp.kind === 'function') {
                const resolved = resolveImportFunc(imp, info.specPath, importSource);
                if (resolved) {
                    funcDescs.push({ module: imp.module, name: imp.name, func: resolved });
                } else {
                    throw new LinkError(`Unresolved import: ${imp.module}::${imp.name} (function)`);
                }
            } else if (imp.kind === 'global') {
                const resolved = resolveGlobalImport(imp, info.specPath, importSource);
                if (resolved) {
                    globalDescs.push(resolved);
                } else {
                    throw new LinkError(`Unresolved import: ${imp.module}::${imp.name} (global)`);
                }
            } else if (imp.kind === 'table') {
                const resolved = resolveTableImport(imp, info.specPath, importSource);
                if (resolved) {
                    tableDescs.push(resolved);
                } else {
                    throw new LinkError(`Unresolved import: ${imp.module}::${imp.name} (table)`);
                }
            } else if (imp.kind === 'memory') {
                const resolved = resolveMemoryImport(imp, info.specPath, importSource);
                if (resolved) {
                    memoryDescs.push(resolved);
                } else {
                    throw new LinkError(`Unresolved import: ${imp.module}::${imp.name} (memory)`);
                }
            }
        }

        if (funcDescs.length)  wasm.resolveImports(wmod, funcDescs);
        if (globalDescs.length) wasm.resolveGlobalImports(wmod, globalDescs);
        if (tableDescs.length)  wasm.resolveTableImports(wmod, tableDescs);
        if (memoryDescs.length) wasm.resolveMemoryImports(wmod, memoryDescs);
    }

    wasm.setWasiOptions(wmod, [], null, null);
    const inst = wasm.buildInstance(wmod);

    // Build ESM module with V8/Deno-compatible export wrappers
    const exp = wasm.moduleExports(wmod);
    const mod = engine.Module.create(info.specPath);
    const ns: Record<string, unknown> = {};

    const wasm2 = wasm;
    for (const e of exp) {
        switch (e.kind) {
            case 'function': {
                const fn = (...args: unknown[]): CModuleWASM.WasmFunctionResult => {
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
                    get(i: number): CModuleWASM.WasmTableValue { return wasm2.tableGet(inst, e.name, i); },
                    set(i: number, v: CModuleWASM.WasmTableValue): void { wasm2.tableSet(inst, e.name, i, v); },
                    grow(d: number): number { return wasm2.tableGrow(inst, e.name, d); },
                };
                Object.defineProperty(tbl, Symbol.toStringTag, { value: 'WebAssembly.Table' });
                ns[e.name] = tbl;
                mod.export(e.name, tbl);
                break;
            }
            case 'global': {
                const gl = {
                    get value(): CModuleWASM.WasmGlobalValue { return wasm2.getGlobal(inst, e.name); },
                    set value(v: CModuleWASM.WasmGlobalValue) { wasm2.setGlobal(inst, e.name, v); },
                    valueOf(): CModuleWASM.WasmGlobalValue { return wasm2.getGlobal(inst, e.name); },
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
    const wrappedInst: {
        callFunction(name: string, ...args: CModuleWASM.WasmValue[]): CModuleWASM.WasmFunctionResult;
        exports: Record<string, unknown>;
    } = {
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

function toWasmValue(v: unknown): CModuleWASM.WasmValue {
    if (typeof v === 'number')  return v;
    if (typeof v === 'bigint')  return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === undefined) return 0;
    if (typeof v === 'string') {
        if (v === '') return 0;
        if (RE_INT_LITERAL.test(v)) return BigInt(v.replace(/n$/, ''));
        return 0;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// WasmCompiler — cache + circular dependency handling
// ---------------------------------------------------------------------------

type LoadFn = (info: ModuleInfo, meta: Record<string, unknown>) => CModuleEngine.Module;
type ResolveFn = (spec: string, parent: string) => ModuleInfo;

export class WasmCompiler {
    private readonly wasmCache   = new Map<string, CModuleEngine.Module>();
    private readonly wasmLoading = new Set<string>();
    private readonly pendingWasm = new Map<string, Record<string, unknown>>();

    load(
        info: ModuleInfo,
        resolve: ResolveFn,
        loadModule: LoadFn,
    ): CModuleEngine.Module {
        const hit = this.wasmCache.get(info.localPath);
        if (hit) return hit;

        if (this.wasmLoading.has(info.localPath)) {
            // Circular dependency — return a placeholder that gains exports later
            log.debug('wasm', () => `cycle: ${info.specPath} -- returning placeholder`);
            const shared: Record<string, unknown> = {};
            const placeholder = engine.Module.create(info.specPath);
            placeholder.export('default', shared);
            this.wasmCache.set(info.localPath, placeholder);
            this.pendingWasm.set(info.localPath, shared);
            return placeholder;
        }

        this.wasmLoading.add(info.localPath);

        const importSource: WasmImportSource = {
            require: (spec: string, parentPath: string) => {
                const resolved = resolve(spec, parentPath);
                const loaded = loadModule(resolved, {});
                loaded.eval();
                const ns = loaded.namespace;
                log.debug('wasm', () => `import "${spec}" resolved -> ${resolved.specPath} (${Object.keys(ns).length} exports)`);
                return ns;
            },
        };

        const result = buildWasmModule(info, importSource);
        this.wasmLoading.delete(info.localPath);

        if (!result) throw err(ErrorKind.Generic, `WASM load failed: ${info.localPath}`);

        // Populate placeholder if one was created during circular resolution
        const pending = this.pendingWasm.get(info.localPath);
        if (pending) {
            const ns = result.mod.namespace;
            Object.assign(pending, ns);

            const placeholder = this.wasmCache.get(info.localPath);
            if (!placeholder) throw err(ErrorKind.Generic, `WASM placeholder missing: ${info.localPath}`);
            for (const key of Object.keys(ns)) {
                try {
                    placeholder.export(key, ns[key]);
                } catch (e) {
                    log.debug('wasm', () => `export "${key}" failed: ${errMsg(e)}`);
                }
            }

            this.pendingWasm.delete(info.localPath);
            log.debug('wasm', () => `populated placeholder: ${info.specPath} (${Object.keys(pending).length} exports)`);
            return placeholder;
        }

        this.wasmCache.set(info.localPath, result.mod);
        return result.mod;
    }

    clearCache(): void {
        this.wasmCache.clear();
    }

    hasPendingLoads(): boolean {
        return this.wasmLoading.size > 0;
    }
}
