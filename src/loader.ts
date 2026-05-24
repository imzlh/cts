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
import { CjsLoader, type CjsDeps, BUILTINS } from './cjs';
import { isTypeDecl } from './protocol/base';
import { readText } from './utils/io';
import { err, ErrorKind } from './errors';
import { log } from './utils/log';
import { fs, engine, errMsg } from './utils/index';
import { JscCache, isRemote } from './jsc';

const store: CModuleEngine.Module[] = [];

import { buildWasmModule, type WasmImportSource } from './wasm';

export class ModuleLoader {
    private readonly transformer = new Transformer();
    private readonly cjs:        CjsLoader;
    private readonly esmCache    = new Map<string, CModuleEngine.Module>();
    /** Modules currently being compiled (circular dep detection). */
    private readonly esmLoading  = new Set<string>();
    private readonly wasmCache   = new Map<string, CModuleEngine.Module>();
    readonly jsc                 = new JscCache();

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

        const CTS_INTERNAL = Symbol.for('cts.internal');
        Object.defineProperty(globalThis, CTS_INTERNAL, {
            value: {
                mkRequire: this.cjs.mkRequire.bind(this.cjs),
                builtinModules: [...BUILTINS],
                cache: this.cjs.cache,
            },
            writable: false,
            enumerable: false,
            configurable: false,
        })
    }

    // -------------------------------------------------------------------------
    // Public: load a module from its ModuleInfo
    // -------------------------------------------------------------------------

    load(info: ModuleInfo, meta: Record<string, any> = {}): CModuleEngine.Module {
        if (isTypeDecl(info.localPath)) {
            throw err(ErrorKind.FileNotFound, `Cannot load type declaration file "${info.localPath}" as a module. Type declaration files (.d.ts) are not executable.`);
        }
        log.debug('loader', () => `load ${info.specPath} kind=${info.fileKind} format=${info.format}`);
        log.debug('loader', () => `alias: ${info.specPath} -> ${info.localPath}`);

        switch (info.fileKind) {
            case 'binary': return this.loadBytes(info);
            case 'text':   return this.loadText(info);
            case 'json':   return this.loadEsm(info, meta);
            case 'wasm':   return this.loadWasm(info);
        }
        return info.format === 'cjs'
            ? this.loadCjs(info, meta)
            : this.loadEsm(info, meta);
    }

    loadSource(code: string, info: ModuleInfo, meta: Record<string, any> = {}): CModuleEngine.Module {
        log.debug('loader', () => `loadSource ${info.specPath} kind=${info.fileKind}`);
        if (info.fileKind === 'text') return this.loadTextSource(code, info);
        return this.loadEsmSource(code, info, meta);
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

        // Circular dependency guard: if this module is already being compiled,
        // return a placeholder. The real exports will be populated after the
        // outer compile finishes. This matches Deno / Node.js ESM circular dep
        // semantics.
        if (this.esmLoading.has(info.localPath)) {
            log.debug('loader', () => `cycle: ${info.specPath} — returning placeholder`);
            const placeholder = engine.Module.create(info.specPath);
            // Register immediately so subsequent circular refs get this object
            this.esmCache.set(info.localPath, placeholder);
            store.push(placeholder);
            return placeholder;
        }

        const remote = isRemote(info.specPath);
        const cacheable = !this.cfg.disableCache && remote;

        // 1) JSC cache: in-memory (from precompile) → on-disk .jsc (remote only)
        if (cacheable) {
            const cached = this.jsc.load(info.localPath, remote);
            if (cached) {
                Object.assign(cached.meta, meta);
                this.esmCache.set(info.localPath, cached);
                store.push(cached);
                return cached;
            }
        }

        // 2) Fallback: read + transform + compile on main thread
        this.esmLoading.add(info.localPath);
        const text = readText(info.localPath);
        const code = this.transformer.transform(text, info.localPath);
        let mod: CModuleEngine.Module;
        try {
            mod = new engine.Module(code, info.specPath);
        } catch (e) {
            this.esmLoading.delete(info.localPath);
            this.esmCache.delete(info.localPath);
            if (e instanceof SyntaxError) {
                const ne = err(ErrorKind.SyntaxError,
                    `Syntax error in ${info.localPath}: ${e.message}`);
                (ne as any).cause = { source: e, code, path: info.localPath };
                throw ne;
            }
            throw e;
        }
        this.esmLoading.delete(info.localPath);

        if (cacheable) {
            this.jsc.persist(info.localPath, mod);
        }

        Object.assign(mod.meta, meta);
        this.esmCache.set(info.localPath, mod);
        store.push(mod);
        return mod;
    }

    private loadEsmSource(code: string, info: ModuleInfo, meta: Record<string, any>): CModuleEngine.Module {
        const hit = this.esmCache.get(info.localPath);
        if (hit) {
            if (meta.main !== undefined) (hit.meta as Record<string, any>).main = meta.main;
            return hit;
        }
        const transformed = this.transformer.transform(code, info.localPath);
        let mod: CModuleEngine.Module;
        try {
            mod = new engine.Module(transformed, info.specPath);
        } catch (e) {
            if (e instanceof SyntaxError) {
                const ne = err(ErrorKind.SyntaxError,
                    `Syntax error in ${info.localPath}: ${e.message}`);
                (ne as any).cause = { source: e, code, path: info.localPath };
                throw ne;
            }
            throw e;
        }
        Object.assign(mod.meta, meta);
        this.esmCache.set(info.localPath, mod);
        store.push(mod);
        return mod;
    }

    private loadCjsSource(code: string, info: ModuleInfo, meta: Record<string, any>): CModuleEngine.Module {
        const transformed = this.transformer.transform(code, info.localPath);
        const cjsMod = this.cjs.loadSourceAndGet(transformed, info.localPath);
        return this.bridgeCjsToEsm(info, meta, cjsMod.exports);
    }

    private loadTextSource(code: string, info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(info.specPath);
        mod.export('default', code);
        store.push(mod);
        return mod;
    }

    // -------------------------------------------------------------------------
    // CJS → ESM bridge
    // -------------------------------------------------------------------------

    private loadCjs(info: ModuleInfo, meta: Record<string, any>): CModuleEngine.Module {
        const cjsMod = this.cjs.loadAndGet(info.localPath);
        return this.bridgeCjsToEsm(info, meta, cjsMod.exports);
    }

    private bridgeCjsToEsm(
        info: ModuleInfo, meta: Record<string, any>, exports: any,
    ): CModuleEngine.Module {
        const mod = engine.Module.create(info.specPath);
        Object.assign(mod.meta, meta);

        if (exports !== null && typeof exports === 'object' && exports.__esModule === true) {
            for (const k of Object.keys(exports)) {
                if (k !== '__esModule') mod.export(k, exports[k]);
            }
            if (!Object.prototype.hasOwnProperty.call(exports, 'default')) {
                mod.export('default', undefined);
            }
        } else {
            if (exports !== null && typeof exports === 'object') {
                for (const k of Object.keys(exports)) {
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

    private readonly wasmLoading = new Set<string>();
    private readonly pendingWasm  = new Map<string, Record<string, any>>();

    private loadWasm(info: ModuleInfo): CModuleEngine.Module {
        const hit = this.wasmCache.get(info.localPath);
        if (hit) return hit;

        if (this.wasmLoading.has(info.localPath)) {
            // Circular dependency (wasm-bindgen: JS glue imports from .wasm,
            // .wasm imports table/memory from JS glue).
            // Return a placeholder whose exports will be populated after the
            // WASM instance is built.  The JS glue receives a live object that
            // gains properties once instantiation completes.
            log.debug('wasm', () => `cycle: ${info.specPath} — returning placeholder`);
            const shared: Record<string, any> = {};
            const placeholder = engine.Module.create(info.specPath);
            placeholder.export('default', shared);
            this.wasmCache.set(info.localPath, placeholder);
            this.pendingWasm.set(info.localPath, shared);
            return placeholder;
        }

        this.wasmLoading.add(info.localPath);

        const importSource: WasmImportSource = {
            require: (spec, parentPath) => {
                try {
                    const resolved = this.resolver.resolve(spec, parentPath);
                    const loaded = this.load(resolved, {});
                    loaded.eval();
                    const ns = loaded.namespace;
                    log.debug('wasm', () => `import "${spec}" resolved → ${resolved.specPath} (${Object.keys(ns).length} exports)`);
                    return ns;
                } catch (e) {
                    log.debug('wasm', () => `import "${spec}" from "${parentPath}" failed: ${errMsg(e)}`);
                    return null;
                }
            },
        };

        const result = buildWasmModule(info, importSource);
        this.wasmLoading.delete(info.localPath);

        if (!result) throw err(ErrorKind.Generic, `WASM load failed: ${info.localPath}`);

        // If a placeholder was created during circular resolution, populate it
        // with the real exports now that the WASM instance is built.
        const pending = this.pendingWasm.get(info.localPath);
        if (pending) {
            const ns = result.mod.namespace;
            Object.assign(pending, ns);

            // Also register named exports on the placeholder module so that
            // `import * as wasm from "./bg.wasm"` → `wasm.memory` works
            // (not just `wasm.default.memory`).
            const placeholder = this.wasmCache.get(info.localPath)!;
            for (const key of Object.keys(ns)) {
                try { placeholder.export(key, ns[key]); } catch { /* ok */ }
            }

            this.pendingWasm.delete(info.localPath);
            log.debug('wasm', () => `populated placeholder: ${info.specPath} (${Object.keys(pending).length} exports)`);
            return placeholder;
        }

        this.wasmCache.set(info.localPath, result.mod);
        store.push(result.mod);
        return result.mod;
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
    // CjsDeps implementation
    // -------------------------------------------------------------------------

    private buildCjsDeps(): CjsDeps {
        const self = this;
        return {
            builtinToPath(name: string, parent: string): string {
                return self.resolver.resolve(`node:${name}`, parent).localPath;
            },

            loadEsmSync(localPath: string, specPath: string): Record<string, any> {
                const info: ModuleInfo = { specPath, localPath, format: 'esm', fileKind: 'source' };
                const mod = self.loadEsm(info, {});

                const p = mod.eval();
                const ns = mod.namespace;

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