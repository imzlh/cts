// loader.ts — ModuleLoader  (ESM + CJS + special types)
//
// ESM/CJS export interop rules (applied in loadCjs):
//   exports.__esModule === true  → Babel/tsc transpiled module:
//     `default` export becomes exports.default (not the whole object)
//     Named exports come from exports directly
//   otherwise (true CJS):
//     `default` export is the whole exports object
//     Named exports are each enumerable key of exports
//
// This matches Node.js 22+ "named exports detection" heuristics.

import type { RuntimeConfig, ModuleInfo } from './types';
import { ModuleResolver } from './resolver';
import { Transformer } from './transformer';
import { CjsLoader, type CjsDeps } from './cjs';
import { isTypeDecl } from './protocol/base';
import { readText, ensureDir } from './utils/io';
import { dirname, extname } from './utils/path';
import { assert } from './utils/misc';
import { log } from './utils/log';
import { fs, engine, wasm } from './utils/index';

// Keep engine modules alive (QuickJS GC would collect them otherwise)
const store: CModuleEngine.Module[] = [];

// ---------------------------------------------------------------------------
// JSC bytecode cache helpers
// ---------------------------------------------------------------------------

type Hint = 'wasm'|'bytes'|'text'|'raw'|'commonjs'|'module'|'';

function hintOf(specPath: string): Hint {
    const qi = specPath.indexOf('?');
    return qi === -1 ? '' : specPath.slice(qi + 1) as Hint;
}

function tryReadJsc(
    jscPath: string, srcPath: string, isRemote: boolean,
): CModuleEngine.Module | null {
    if (!fs.exists(jscPath)) return null;
    try {
        if (!isRemote) {
            const sm = (() => { try { return (fs.stat(srcPath) as any).mtim?.getTime?.() ?? 0; } catch { return 0; } })();
            const jm = (() => { try { return (fs.stat(jscPath) as any).mtim?.getTime?.() ?? 0; } catch { return 0; } })();
            if (jm < sm) return null;
        }
        const jscBytes = fs.readFile(jscPath);
        const cached = engine.deserialize(new Uint8Array(jscBytes));
        return cached;
    } catch { return null; }
}

// ---------------------------------------------------------------------------
// ModuleLoader
// ---------------------------------------------------------------------------

export class ModuleLoader {
    private readonly transformer = new Transformer();
    private readonly cjs:        CjsLoader;
    private readonly esmCache  = new Map<string, CModuleEngine.Module>();

    constructor(
        private readonly resolver: ModuleResolver,
        private readonly cfg:      RuntimeConfig,
    ) {
        this.cjs = new CjsLoader(this.buildCjsDeps());

        let requireFn: Function | undefined;
        Object.defineProperty(globalThis, 'require', {
            get: () => {
                if (!requireFn) requireFn = this.cjs.mkRequire(
                    // @ts-ignore - entry donot has parent module
                    resolver.entry, undefined
                );
                return requireFn;
            },
            enumerable: true,
            configurable: true,
        })
    }

    // -------------------------------------------------------------------------
    // Public: load a module from its ModuleInfo
    // -------------------------------------------------------------------------

    load(info: ModuleInfo, meta: Record<string, any> = {}): CModuleEngine.Module {
        if (isTypeDecl(info.localPath)) {
            throw new Error(`Cannot load type declaration file "${info.localPath}" as a module. Type declaration files (.d.ts) are not executable.`);
        }
        const hint = hintOf(info.specPath);
        log.debug('loader', () => `load ${info.specPath} hint=${hint} kind=${info.fileKind} format=${info.format}`);
        log.debug('loader', () => `alias: ${info.specPath} -> ${info.localPath}`);
        if (hint === 'commonjs') return this.loadCjs(info, meta);
        if (hint === 'module')   return this.loadEsm(info, meta);
        if (hint === 'wasm')     return this.loadWasm(info);
        if (hint === 'bytes' || hint === 'raw') return this.loadBytes(info);
        if (hint === 'text')     return this.loadText(info);
        switch (info.fileKind) {
            case 'wasm':   return this.loadWasm(info);
            case 'binary': return this.loadBytes(info);
            case 'json':   return this.loadEsm(info, meta);  // transformer wraps as export default
            default:
                return info.format === 'cjs'
                    ? this.loadCjs(info, meta)
                    : this.loadEsm(info, meta);
        }
    }

    preRegister(localPath: string, parentPath: string): void {
        this.cjs.preRegister(localPath, parentPath);
    }

    // -------------------------------------------------------------------------
    // ESM loading
    // -------------------------------------------------------------------------

    private loadEsm(info: ModuleInfo, meta: Record<string, any>): CModuleEngine.Module {
        const hit = this.esmCache.get(info.localPath);
        if (hit) {
            if (meta.main !== undefined) (hit.meta as Record<string, any>).main = meta.main;
            return hit;
        }

        const isRemote = info.specPath.startsWith('http://') || info.specPath.startsWith('https://') || info.specPath.startsWith('jsr:') || info.specPath.startsWith('npm:');
        // JSC bytecode cache: only for remote/cached modules, not local source files.
        // Local files change frequently and .jsc files would litter the project directory.
        const cacheable = !this.cfg.disableCache && isRemote;
        const jscPath   = info.localPath + '.jsc';

        if (cacheable) {
            const cached   = tryReadJsc(jscPath, info.localPath, isRemote);
            if (cached) {
                Object.assign(cached.meta, meta);
                this.esmCache.set(info.localPath, cached);
                store.push(cached);
                return cached;
            }
        }

        const text = readText(info.localPath);
        const code = this.transformer.transform(text, info.localPath);
        let mod: CModuleEngine.Module;
        try {
            mod = new engine.Module(code, info.specPath);
        } catch (e) {
            if (e instanceof SyntaxError) throw new SyntaxError(
                `Syntax error in ${info.localPath}: ${e.message}`,
                { cause: { source: e, code, path: info.localPath } },
            );
            throw e;
        }

        if (cacheable) {
            try { ensureDir(dirname(jscPath)); fs.writeFile(jscPath, mod.dump()); }
            catch (e) { log.warn('loader', 'jsc write failed', e); }
        }

        Object.assign(mod.meta, meta);
        this.esmCache.set(info.localPath, mod);
        store.push(mod);
        return mod;
    }

    // -------------------------------------------------------------------------
    // CJS → ESM bridge: expose CJS exports as a proper ESM module
    //
    // __esModule detection (Babel/tsc interop):
    //   When a CJS module sets exports.__esModule = true, it was transpiled from
    //   ESM. In this case:
    //     - `default` export = exports.default   (not the whole exports object)
    //     - Named exports   = all other keys of exports
    //   Without __esModule:
    //     - `default` export = the whole exports object (true CJS)
    //     - Named exports   = each enumerable key of exports
    //
    // This matches the behaviour of rollup, webpack, vite, and Node.js CJS↔ESM.
    // -------------------------------------------------------------------------

    private loadCjs(info: ModuleInfo, meta: Record<string, any>): CModuleEngine.Module {
        const cjsMod  = this.cjs.loadAndGet(info.localPath);
        const exports = cjsMod.exports;

        const mod = engine.Module.create(info.specPath);
        Object.assign(mod.meta, meta);

        const isTranspiledEsm =
            exports !== null &&
            typeof exports === 'object' &&
            exports.__esModule === true;

        if (isTranspiledEsm) {
            // Transpiled ESM (Babel/tsc): export each key, default is exports.default
            for (const k of Object.keys(exports)) {
                if (k !== '__esModule') mod.export(k, exports[k]);
            }
            // Ensure `default` is always present
            if (!Object.prototype.hasOwnProperty.call(exports, 'default')) {
                mod.export('default', undefined);
            }
        } else {
            // True CJS: default = whole exports, also export each named key
            if (exports !== null && typeof exports === 'object') {
                for (const k of Object.keys(exports)) {
                    // Skip prototype-inherited and non-enumerable; skip 'default'
                    // which we set explicitly below to avoid conflicts
                    if (k !== 'default') mod.export(k, exports[k]);
                }
            }
            mod.export('default', exports);
        }

        store.push(mod);
        return mod;
    }

    // -------------------------------------------------------------------------
    // Special file types
    // -------------------------------------------------------------------------

    private loadWasm(info: ModuleInfo): CModuleEngine.Module {
        assert(wasm, 'WASM support not available in this build');

        const raw = fs.readFile(info.localPath);
        const wmod = wasm.parseModule(raw);

        // Resolve imports: bridge WASM import requirements to JS functions
        const imports = wasm.moduleImports(wmod);
        if (imports.length > 0) {
            const funcDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
            const globalDescs: CModuleWASM.GlobalImportDescriptor[] = [];
            for (const imp of imports) {
                if (imp.kind === 'function') {
                    // Provide a no-op stub for unresolved function imports.
                    // Users can override via the `wasmImports` export before calling.
                    funcDescs.push({
                        module: imp.module,
                        name:   imp.name,
                        func:   (..._args: CModuleWASM.WasmValue[]) => 0,
                    });
                } else if (imp.kind === 'global') {
                    // Default global import: i32(0), immutable
                    globalDescs.push({
                        module:  imp.module,
                        name:    imp.name,
                        value:   0,
                        type:    'i32',
                        mutable: false,
                    });
                }
                // 'memory' and 'table' imports are handled internally by WAMR
            }
            if (funcDescs.length > 0)  wasm.resolveImports(wmod, funcDescs);
            if (globalDescs.length > 0) wasm.resolveGlobalImports(wmod, globalDescs);
        }

        // Set default WASI options (empty args/env/preopens)
        wasm.setWasiOptions(wmod, [], null, null);

        const inst = wasm.buildInstance(wmod);
        const exp  = wasm.moduleExports(wmod);
        const mod  = engine.Module.create(info.specPath);

        // Build a namespace object that mirrors the standard WebAssembly.Instance.exports
        const ns: Record<string, any> = {};

        for (const e of exp) {
            switch (e.kind) {
                case 'function': {
                    const fn = (...args: any[]): CModuleWASM.WasmValue | CModuleWASM.WasmValue[] => {
                        const wargs: CModuleWASM.WasmValue[] = args.map(a => this.toWasmValue(a));
                        return inst.callFunction(e.name, ...wargs);
                    };
                    ns[e.name] = fn;
                    mod.export(e.name, fn);
                    break;
                }
                case 'memory': {
                    const mem = {
                        get buffer(): ArrayBuffer {
                            return wasm!.getMemoryBuffer(inst);
                        },
                        grow(delta: number): number {
                            return wasm!.growMemory(inst, delta);
                        },
                    };
                    ns[e.name] = mem;
                    mod.export(e.name, mem);
                    break;
                }
                case 'global': {
                    const gl = {
                        get value(): CModuleWASM.WasmValue {
                            return wasm!.getGlobal(inst, e.name);
                        },
                        set value(v: CModuleWASM.WasmValue) {
                            wasm!.setGlobal(inst, e.name, v);
                        },
                        get info(): CModuleWASM.GlobalInfo {
                            return wasm!.getGlobalInfo(inst, e.name);
                        },
                    };
                    ns[e.name] = gl;
                    mod.export(e.name, gl);
                    break;
                }
                case 'table': {
                    const tbl = {
                        get length(): number {
                            return wasm!.tableSize(inst, e.name);
                        },
                        get info(): CModuleWASM.TableInfo {
                            return wasm!.getTableInfo(inst, e.name);
                        },
                        get(index: number): number | null {
                            return wasm!.tableGet(inst, e.name, index) as number | null;
                        },
                        set(index: number, value: number | null): void {
                            wasm!.tableSet(inst, e.name, index, value);
                        },
                        grow(delta: number): number {
                            return wasm!.tableGrow(inst, e.name, delta);
                        },
                    };
                    ns[e.name] = tbl;
                    mod.export(e.name, tbl);
                    break;
                }
            }
        }

        // Export the full namespace as `default` for `import ns from './mod.wasm'`
        mod.export('default', ns);

        // Expose the raw instance for advanced usage (memory, globals, tables, funcByIndex)
        mod.export('instance', inst);

        store.push(mod);
        return mod;
    }

    /**
     * Convert a JS value to a WASM-compatible value (number | bigint).
     * - number  → number (i32/f32/f64)
     * - bigint  → bigint (i64)
     * - boolean → 0 | 1  (i32)
     * - string  → parseInt/BigInt  (best-effort)
     * - null/undefined → 0
     */
    private toWasmValue(v: unknown): CModuleWASM.WasmValue {
        if (typeof v === 'number')  return v;
        if (typeof v === 'bigint')  return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (v === null || v === undefined) return 0;
        if (typeof v === 'string') {
            // Try integer parse first, then float
            const s = v as string;
            if (s === '') return 0;
            if (/^-?\d+n?$/.test(s)) return BigInt(s.replace(/n$/, ''));
            return Number(s);
        }
        return 0;
    }

    private loadBytes(info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(info.specPath);
        mod.export('default', new Uint8Array(fs.readFile(info.localPath)));
        store.push(mod);
        return mod;
    }

    private loadText(info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(info.specPath);
        mod.export('default', readText(info.localPath));
        store.push(mod);
        return mod;
    }

    // -------------------------------------------------------------------------
    // CjsDeps implementation: bridges CJS loader back to ESM resolver/loader
    // -------------------------------------------------------------------------

    private buildCjsDeps(): CjsDeps {
        const self = this;
        return {
            builtinToPath(name: string, parent: string): string {
                return self.resolver.resolve(`node:${name}`, parent).localPath;
            },

            /**
             * Load ESM module synchronously for CJS interop.
             * Uses engine.promiseResult to extract the result without top-level await.
             * This works because ESM modules without top-level await evaluate synchronously
             * in QuickJS — the Promise is already resolved when eval() returns.
             */
            loadEsmSync(localPath: string, specPath: string): Record<string, any> {
                const info: ModuleInfo = { specPath, localPath, format: 'esm', fileKind: 'source' };
                const mod = self.loadEsm(info, {});

                // Drive the module evaluation synchronously
                const p = mod.eval();
                const ns = mod.namespace;

                // If the module uses top-level await, namespace may be empty.
                // Log a warning but don't crash — the CJS side will get an empty object.
                if (Object.keys(ns).length === 0 && engine.promiseResult(p) === null) {
                    log.warn('loader',
                        () => `${specPath} uses top-level await; CJS require() may get empty exports`);
                }

                return ns;
            },

            resolveExternal(req: string, parent: string): { path: string; isCjs: boolean } | null {
                try {
                    const info = self.resolver.resolve(req, parent, { cjs: true });
                    return { path: info.localPath, isCjs: info.format === 'cjs' };
                } catch { return null; }
            },
        };
    }
}
