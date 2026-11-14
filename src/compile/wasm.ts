import { moduleRef, type ModuleInfo } from '../types';
import { errMsg, log, assert, readBytes } from '../utils';
import { err, codeForKind, ErrorKind, isErrorKind, setErrorCode } from '../errors';

const engine = import.meta.use('engine');
const wasm = import.meta.use('wasm');

type WasmImportExports = Record<string, unknown>;
type WasmImportFunction = (...args: CModuleWASM.WasmFunctionArgument[]) =>
    CModuleWASM.WasmFunctionResult | void;

// Error classes — V8/Deno WebAssembly API compatibility

export class CompileError extends Error {
    constructor(message: string) { super(message); this.name = 'CompileError'; }
}
export class LinkError extends Error {
    constructor(message: string, kind: ErrorKind = ErrorKind.ModuleNotFound) {
        super(message); this.name = 'LinkError'; this.kind = kind;
    }
}
export class RuntimeError extends Error {
    constructor(message: string) { super(message); this.name = 'RuntimeError'; }
}

// Built-in "env" module + WASI module names

const ENV_MODULE: Record<string, (...args: number[]) => number> = {
    floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, round: Math.round,
    abs: Math.abs, sqrt: Math.sqrt, fmod: (a: number, b: number) => a % b,
    pow: Math.pow, exp: Math.exp, log: Math.log,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    min_f32: (a: number, b: number) => Math.fround(Math.min(a, b)),
    max_f32: (a: number, b: number) => Math.fround(Math.max(a, b)),
    memory: () => 0,
    now: Date.now,
    emscripten_get_now: () => globalThis.performance?.now?.() ?? Date.now(),
};

// WASI module names — handled by Module.configureWasi(), skip manual resolution
const WASI_MODULES = new Set(['wasi_unstable', 'wasi_snapshot_preview1']);

// Heuristic match for "the env module": env, ./env.js, env.js
const RE_ENV_MODULE = /^(?:\.\/)?env(?:\.js)?$/;

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

/* Export wrappers carry their defining native instance and kind-relative
 * extern index so a wasm->wasm import links as a live provider instead of a
 * same-size stand-in: state stays shared and calls never round-trip JS. */
const NATIVE_INSTANCE = Symbol('cts.wasm.nativeInstance');
const NATIVE_EXTERN_INDEX = Symbol('cts.wasm.nativeExternIndex');
const FUNCREF_CALLABLE = Symbol('cts.wasm.funcrefCallable');

function nativeExternBacking(value: unknown): { instance: CModuleWASM.Instance; index: number } | null {
    const isTagged = value !== null
        && (typeof value === 'object' || typeof value === 'function')
        && Reflect.has(value, NATIVE_INSTANCE)
        && Reflect.has(value, NATIVE_EXTERN_INDEX);
    if (isTagged) {
        const instance = Reflect.get(value, NATIVE_INSTANCE) as CModuleWASM.Instance;
        const index = Reflect.get(value, NATIVE_EXTERN_INDEX) as number;
        if (instance && Number.isInteger(index) && index >= 0) return { instance, index };
    }
    return null;
}

function tagNativeExport(target: object, instance: CModuleWASM.Instance, index: number): void {
    Object.defineProperty(target, NATIVE_INSTANCE, { value: instance });
    Object.defineProperty(target, NATIVE_EXTERN_INDEX, { value: index });
}

/* Native wasm errors carry a `wasmError` tag; map them onto the facade error
 * classes so consumers can catch WebAssembly.CompileError/LinkError/etc. */
function toWasmFacadeError(e: unknown): unknown {
    if (e instanceof Error) {
        const tag = Reflect.get(e, 'wasmError');
        if (tag === 'CompileError') return new CompileError(e.message);
        if (tag === 'LinkError') return new LinkError(e.message, ErrorKind.ModuleNotFound);
        if (tag === 'RuntimeError') return new RuntimeError(e.message);
    }
    return e;
}

function mapWasmError<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        throw toWasmFacadeError(e);
    }
}

function pendingExportValue(values: Record<string, unknown>, name: string): unknown {
    const value = values[name];
    if (value === undefined) throw new LinkError(`Circular WASM export "${name}" is not initialized`);
    return value;
}

function pendingObjectExport(values: Record<string, unknown>, name: string): object {
    return new Proxy({}, {
        get(_target, key) {
            const value = pendingExportValue(values, name);
            if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
                throw new LinkError(`Circular WASM export "${name}" is not an object`);
            }
            const field = Reflect.get(value, key, value);
            return typeof field === 'function' ? field.bind(value) : field;
        },
        set(_target, key, field) {
            const value = pendingExportValue(values, name);
            if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
                throw new LinkError(`Circular WASM export "${name}" is not an object`);
            }
            return Reflect.set(value, key, field, value);
        },
    });
}

function pendingNamedExport(
    values: Record<string, unknown>,
    descriptor: CModuleWASM.ModuleExportDescriptor,
): unknown {
    if (descriptor.kind !== 'function') return pendingObjectExport(values, descriptor.name);
    return (...args: unknown[]) => {
        const value = pendingExportValue(values, descriptor.name);
        if (typeof value !== 'function') {
            throw new LinkError(`Circular WASM export "${descriptor.name}" is not callable`);
        }
        return Reflect.apply(value, undefined, args);
    };
}

function resolveFunctionImport(
    imp: CModuleWASM.ModuleImportDescriptor,
    parentPath: string,
    importSource: WasmImportSource,
): CModuleWASM.ImportFunctionDescriptor | null {
    assert(wasm, "WASM support not available in this build");
    const { module: modName, name: fnName } = imp;

    let resolveErr: unknown = null;
    try {
        const exports = importSource.require(modName, parentPath);
        if (exports) {
            const fn = getExport(exports, fnName);
            const backing = nativeExternBacking(fn);
            if (backing) {
                const { instance, index } = backing;
                return {
                    module: modName,
                    name: fnName,
                    /* The closure stays a correct fallback if the provider
                     * binding is ever unavailable; native linkage is the fast path. */
                    func: (...args: CModuleWASM.WasmFunctionArgument[]) =>
                        instance.callByIndex(index, ...args),
                    provider: instance,
                    sourceIndex: index,
                };
            }
            if (typeof fn === 'function') {
                return { module: modName, name: fnName, func: fn as WasmImportFunction };
            }
            if (fn !== undefined) return { module: modName, name: fnName, func: () => toWasmValue(fn) };
        }
    } catch (e) {
        resolveErr = e;
        const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : '';
        log.debug('wasm', () => `import resolve "${modName}" failed: ${errMsg(e)}\n${stack}`);
    }

    if (RE_ENV_MODULE.test(modName)) {
        const fn = ENV_MODULE[fnName];
        if (fn) return { module: modName, name: fnName, func: (...args) => fn(...args.map(Number)) };
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
                let rawElement = getObjectField(table, 'element');
                if (rawElement === undefined) rawElement = getObjectField(getObjectField(table, 'type'), 'element');
                const element = rawElement === 'anyfunc' || rawElement === 'funcref' ? 'funcref' as const : 'externref' as const;
                const backing = nativeExternBacking(table);
                log.debug('wasm', () => `table import "${modName}::${fieldName}" resolved (element=${element}, initial=${length}${backing ? ', live provider' : ''})`);
                return backing
                    ? { module: modName, name: fieldName, element, initial: length, provider: backing.instance, sourceIndex: backing.index }
                    : { module: modName, name: fieldName, element, initial: length };
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
                const backing = nativeExternBacking(mem);
                return backing
                    ? { module: modName, name: fieldName, initial, provider: backing.instance, sourceIndex: backing.index }
                    : { module: modName, name: fieldName, initial };
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
                const backing = nativeExternBacking(g);
                const rawMutable = getObjectField(getObjectField(g, 'type'), 'mutable');
                const mutable = typeof rawMutable === 'boolean' ? rawMutable : true;
                if (vtype !== 'number' && vtype !== 'bigint') {
                    return { module: modName, name: fieldName, value: 0, type: 'i32' as const, mutable, ...backing && { provider: backing.instance, sourceIndex: backing.index } };
                }
                const type = vtype === 'bigint' ? 'i64' as const
                    : vtype === 'number' ? (Number.isInteger(raw) ? 'i32' as const : 'f64' as const)
                    : 'i32' as const;
                return { module: modName, name: fieldName, value: raw, type, mutable, ...backing && { provider: backing.instance, sourceIndex: backing.index } };
            }
        }
    } catch (e) {
        log.debug('wasm', () => `global import "${modName}::${fieldName}" resolve failed: ${errMsg(e)}`);
    }
    return null;
}

export function buildWasmModule(
    info: ModuleInfo,
    importSource: WasmImportSource,
): { mod: CModuleEngine.Module; instance: CModuleWASM.Instance } | null {
    if (!wasm) return null;

    const raw = readBytes(info.localPath);
    const wmod = mapWasmError(() => wasm.load(raw));

    const imports = wmod.imports();
    if (imports.length > 0) {
        const funcDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
        const globalDescs: CModuleWASM.GlobalImportDescriptor[] = [];
        const tableDescs: CModuleWASM.TableImportDescriptor[] = [];
        const memoryDescs: CModuleWASM.MemoryImportDescriptor[] = [];

        for (const imp of imports) {
            if (WASI_MODULES.has(imp.module)) continue;

            if (imp.kind === 'function') {
                const resolved = resolveFunctionImport(imp, info.specPath, importSource);
                if (resolved) {
                    funcDescs.push(resolved);
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (function) in ${info.localPath}`);
                }
            } else if (imp.kind === 'global') {
                const resolved = resolveGlobalImport(imp, info.specPath, importSource);
                if (resolved) {
                    globalDescs.push(resolved);
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (global) in ${info.localPath}`);
                }
            } else if (imp.kind === 'table') {
                const resolved = resolveTableImport(imp, info.specPath, importSource);
                if (resolved) {
                    tableDescs.push(resolved);
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (table) in ${info.localPath}`);
                }
            } else if (imp.kind === 'memory') {
                const resolved = resolveMemoryImport(imp, info.specPath, importSource);
                if (resolved) {
                    memoryDescs.push(resolved);
                } else {
                    throw new LinkError(
                        `Unresolved import: ${imp.module}::${imp.name} (memory) in ${info.localPath}`);
                }
            }
        }

        if (funcDescs.length)  mapWasmError(() => wmod.resolveFunctions(funcDescs));
        if (globalDescs.length) mapWasmError(() => wmod.resolveGlobals(globalDescs));
        if (tableDescs.length)  mapWasmError(() => wmod.resolveTables(tableDescs));
        if (memoryDescs.length) mapWasmError(() => wmod.resolveMemories(memoryDescs));
    }

    mapWasmError(() => wmod.configureWasi({ args: [] }));
    const inst = mapWasmError(() => wmod.instantiate());

    const exp = wmod.exports();
    const mod = engine.Module.create(info.specPath);
    const ns: Record<string, unknown> = {};

    /* Function wrappers are created once so a table slot and the namespace can
     * share one identity, like the JS API's Table.get() === exports.fn. */
    const fnWrappers = new Map<number, (...args: unknown[]) => CModuleWASM.WasmFunctionResult>();
    for (const e of exp) {
        if (e.kind !== 'function') continue;
        fnWrappers.set(e.externIndex, (...args: unknown[]) =>
            mapWasmError(() => inst.call(e.name, ...args.map(toWasmValue))));
    }

    for (const e of exp) {
        switch (e.kind) {
            case 'function': {
                const fn = fnWrappers.get(e.externIndex)!;
                tagNativeExport(fn, inst, e.externIndex);
                ns[e.name] = fn;
                mod.export(e.name, fn);
                break;
            }
            case 'memory': {
                const mem = {
                    get buffer(): ArrayBuffer { return inst.memoryBuffer(); },
                    grow(delta: number): number { return inst.growMemory(delta); },
                    get type(): { minimum: number; maximum?: number } {
                        const buf = inst.memoryBuffer();
                        return { minimum: Math.ceil(buf.byteLength / 65536) };
                    },
                };
                Object.defineProperty(mem, Symbol.toStringTag, { value: 'WebAssembly.Memory' });
                tagNativeExport(mem, inst, e.externIndex);
                ns[e.name] = mem;
                mod.export(e.name, mem);
                break;
            }
            case 'table': {
                const tableInfo = inst.tableInfo(e.name);
                const isFuncref = tableInfo.element === 'funcref' || tableInfo.element === 'unknown';
                const funcrefCache = new Map<number, CModuleWASM.WasmTableValue>();
                const makeFuncrefCallable = (owner: CModuleWASM.Instance, index: number): CModuleWASM.WasmTableValue => {
                    const cached = funcrefCache.get(index);
                    if (typeof cached === 'function' && Reflect.has(cached, FUNCREF_CALLABLE)) {
                        const tag = Reflect.get(cached, FUNCREF_CALLABLE) as { owner: CModuleWASM.Instance };
                        if (tag.owner === owner) return cached;
                    }
                    const callable = ((...args: unknown[]) =>
                        mapWasmError(() => owner.callByIndex(index, ...args.map(toWasmValue)))) as CModuleWASM.WasmTableValue;
                    Object.defineProperty(callable, FUNCREF_CALLABLE, { value: { owner, index } });
                    funcrefCache.set(index, callable);
                    return callable;
                };
                const tbl = {
                    get length(): number { return inst.tableSize(e.name); },
                    get type(): { element: 'funcref' | 'externref'; minimum: number; maximum?: number } {
                        const info = inst.tableInfo(e.name);
                        const element = info.element === 'unknown'
                            ? 'funcref' as const
                            : info.element as 'funcref' | 'externref';
                        return {
                            element,
                            minimum: info.cur_size,
                            maximum: info.max_size > 0 ? info.max_size : undefined,
                        };
                    },
                    get(i: number): CModuleWASM.WasmTableValue {
                        const raw = inst.tableGet(e.name, i);
                        /* funcref slots come back as {owner, index}; return the
                         * shared function wrapper when the slot points at one of
                         * this instance's own exports (Table.get() === exports.fn),
                         * else a stable callable invoking the defining instance. */
                        if (isFuncref && raw !== null && raw !== undefined && typeof raw === 'object'
                            && 'owner' in raw && 'index' in raw) {
                            const ref = raw as { owner: CModuleWASM.Instance; index: number };
                            if (ref.owner === inst) {
                                const wrapper = fnWrappers.get(ref.index);
                                if (wrapper) return wrapper as CModuleWASM.WasmTableValue;
                            }
                            return makeFuncrefCallable(ref.owner, ref.index);
                        }
                        return raw;
                    },
                    set(i: number, v: CModuleWASM.WasmTableValue): void {
                        /* Accept our own function wrappers and funcref callables
                         * back (convert to the owning instance's index). Only
                         * funcref tables convert: an externref table stores the
                         * callable as a plain externref value. */
                        let target: { instance: CModuleWASM.Instance; index: number } | null = null;
                        if (isFuncref && typeof v === 'function') {
                            target = nativeExternBacking(v);
                            if (!target && Reflect.has(v, FUNCREF_CALLABLE)) {
                                const tag = Reflect.get(v, FUNCREF_CALLABLE) as { owner: CModuleWASM.Instance; index: number };
                                target = { instance: tag.owner, index: tag.index };
                            }
                        }
                        /* C coerces any other non-null value to function index 0,
                         * silently aliasing the slot; mirror the facade and reject. */
                        if (isFuncref && target === null && v !== null) {
                            throw new TypeError('Argument 1 must be null or a WebAssembly function');
                        }
                        if (target) {
                            if (target.instance !== inst) {
                                throw new TypeError('Argument 1 must be null or a WebAssembly function');
                            }
                            inst.tableSet(e.name, i, target.index);
                            return;
                        }
                        inst.tableSet(e.name, i, v);
                    },
                    grow(d: number): number { return inst.tableGrow(e.name, d); },
                };
                Object.defineProperty(tbl, Symbol.toStringTag, { value: 'WebAssembly.Table' });
                tagNativeExport(tbl, inst, e.externIndex);
                ns[e.name] = tbl;
                mod.export(e.name, tbl);
                break;
            }
            case 'global': {
                const gl = {
                    get value(): CModuleWASM.WasmGlobalValue { return inst.getGlobal(e.name); },
                    set value(v: CModuleWASM.WasmGlobalValue) { inst.setGlobal(e.name, v); },
                    valueOf(): CModuleWASM.WasmGlobalValue { return inst.getGlobal(e.name); },
                    get type(): { value: 'i32' | 'i64' | 'f32' | 'f64'; mutable: boolean } {
                        const info = inst.globalInfo(e.name);
                        const vt = (info.type === 'externref' || info.type === 'funcref'
                            || info.type === 'v128' || info.type === 'unknown')
                            ? 'i32' as const
                            : info.type;
                        return { value: vt, mutable: info.mutable };
                    },
                };
                Object.defineProperty(gl, Symbol.toStringTag, { value: 'WebAssembly.Global' });
                tagNativeExport(gl, inst, e.externIndex);
                ns[e.name] = gl;
                mod.export(e.name, gl);
                break;
            }
        }
    }

    // V8/Deno compatibility
    const wrappedInst: {
        callFunction(name: string, ...args: CModuleWASM.WasmValue[]): CModuleWASM.WasmFunctionResult;
        exports: Record<string, unknown>;
    } = {
        callFunction: (name: string, ...args: CModuleWASM.WasmValue[]) =>
            mapWasmError(() => inst.call(name, ...args)),
        exports: ns,
    };
    Object.defineProperty(wrappedInst, Symbol.toStringTag, { value: 'WebAssembly.Instance' });

    mod.export('default', ns);
    mod.export('instance', wrappedInst);

    log.debug('wasm', () => `loaded: ${exp.length} exports`);
    return { mod, instance: inst };
}

function toWasmValue(v: unknown): CModuleWASM.WasmFunctionArgument {
    /* Coercion happens at the native call boundary, where the signature is known:
     * zeroing non-numbers here destroyed externref args (e.g. @deno/loader's
     * wasm-bindgen options object). */
    return v as CModuleWASM.WasmFunctionArgument;
}

// WasmCompiler — cache + circular dependency handling

type LoadFn = (info: ModuleInfo, meta: Record<string, unknown>) => CModuleEngine.Module;
type ResolveFn = (spec: string, parent: string) => ModuleInfo;
/** Supplied by the caller so evaluation is bracketed (ModuleCompiler.evalTracked);
 *  a bare `mod.eval()` here lets a JS dependency be require()d back mid-evaluation,
 *  .eval()ing a JS_MODULE_STATUS_EVALUATING module and aborting the process. */
type EvalFn = (mod: CModuleEngine.Module) => unknown;

interface PendingWasmModule {
    module: CModuleEngine.Module;
    values: Record<string, unknown>;
}

export class WasmCompiler {
    private readonly wasmCache   = new Map<string, CModuleEngine.Module>();
    private readonly wasmLoading = new Set<string>();
    private readonly pendingWasm = new Map<string, PendingWasmModule>();

    load(
        info: ModuleInfo,
        resolve: ResolveFn,
        loadModule: LoadFn,
        evalModule: EvalFn = (mod) => mod.eval(),
    ): CModuleEngine.Module {
        const hit = this.wasmCache.get(info.localPath);
        if (hit) return hit;

        if (this.wasmLoading.has(info.localPath)) {
            log.debug('wasm', () => `cycle: ${info.specPath} -- returning placeholder`);
            const values: Record<string, unknown> = {};
            const placeholder = engine.Module.create(info.specPath);
            placeholder.export('default', values);
            assert(wasm, 'WASM support not available in this build');
            const descriptors = mapWasmError(() => wasm.load(readBytes(info.localPath))).exports();
            for (const descriptor of descriptors) {
                if (descriptor.name === 'default' || descriptor.name === 'instance') continue;
                placeholder.export(descriptor.name, pendingNamedExport(values, descriptor));
            }
            placeholder.export('instance', pendingObjectExport(values, 'instance'));
            this.wasmCache.set(info.localPath, placeholder);
            this.pendingWasm.set(info.localPath, { module: placeholder, values });
            return placeholder;
        }

        this.wasmLoading.add(info.localPath);
        let failError: Error | null = null;
        let rootCause: Error | undefined;
        try {
            // A WASM module can have many import entries from one JS module.
            // Resolve and evaluate each imported ESM namespace once.
            const importedNamespaces = new Map<string, WasmImportExports>();
            const importSource: WasmImportSource = {
                require: (spec: string, parentPath: string) => {
                    const resolved = resolve(spec, parentPath);
                    const key = `${moduleRef(resolved)}\0${resolved.fileKind}`;
                    const cached = importedNamespaces.get(key);
                    if (cached) return cached;

                    const loaded = loadModule(resolved, {});
                    const evalResult = engine.promiseResult(
                        evalModule(loaded) as ReturnType<CModuleEngine.Module['eval']>,
                    );
                    if (evalResult === null) {
                        // Node: ERR_REQUIRE_ASYNC_MODULE (a WASM glue's async import).
                        rootCause = err(ErrorKind.Generic,
                            `Cannot require() async ESM module '${resolved.specPath}' as a WASM dependency`,
                            undefined, 'ERR_REQUIRE_ASYNC_MODULE');
                        throw rootCause;
                    }
                    const ns = loaded.namespace;
                    importedNamespaces.set(key, ns);
                    log.debug('wasm', () => `import "${spec}" resolved -> ${resolved.specPath} (${Object.keys(ns).length} exports)`);
                    return ns;
                },
            };

            const result = buildWasmModule(info, importSource);
            if (!result) throw err(ErrorKind.Generic, `WASM load failed: ${info.localPath}`);
            return this.finishLoad(info, result.mod);
        } catch (e) {
            if (e instanceof LinkError) {
                // Unresolved imports are thrown as LinkError already; carry the code.
                // Keep it linear: QuickJS rebuilds errors that cross a C boundary.
                const coded = e as LinkError & { code?: string };
                if (coded.code === undefined) setErrorCode(e, codeForKind(e.kind ?? ErrorKind.ModuleNotFound)!);
                // Preserve the root failure: an async glue dependency must not read
                // as a plain missing import. Non-enumerable, so the error stays linear.
                if (e.cause === undefined) {
                    Object.defineProperty(e, 'cause', {
                        value: rootCause ?? e, writable: true, enumerable: false, configurable: true,
                    });
                }
                // buildWasmModule reports "Unresolved import", which misdescribes a
                // glue module that failed to evaluate. State the real reason when known:
                // a QuickJS error rebuilt across this boundary keeps only its message.
                if (rootCause && e.message.startsWith('Unresolved import')) e.message = rootCause.message;
            } else if (e instanceof Error && isErrorKind(e.kind)) {
                // Keep the WebAssembly-style LinkError identity, attach the coded cause.
                const wrapped = Object.assign(new LinkError(e.message, e.kind), { cause: e });
                failError = setErrorCode(wrapped, codeForKind(e.kind)!);
                throw failError;
            }
            if (e instanceof Error) failError = e;
            throw e;
        } finally {
            this.wasmLoading.delete(info.localPath);
            if (failError) {
                this.pendingWasm.delete(info.localPath);
                this.wasmCache.delete(info.localPath);
            }
        }
    }

    /** Populate a placeholder created during circular resolution, else cache. */
    private finishLoad(info: ModuleInfo, mod: CModuleEngine.Module): CModuleEngine.Module {
        const pending = this.pendingWasm.get(info.localPath);
        if (pending) {
            const ns = mod.namespace;
            Object.assign(pending.values, ns);

            this.pendingWasm.delete(info.localPath);
            log.debug('wasm', () =>
                `populated placeholder: ${info.specPath} (${Object.keys(pending.values).length} exports)`);
            return pending.module;
        }

        this.wasmCache.set(info.localPath, mod);
        return mod;
    }

    clearCache(): void {
        this.wasmCache.clear();
    }

    hasPendingLoads(): boolean {
        return this.wasmLoading.size > 0;
    }
}
