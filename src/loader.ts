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
import { JscCache, isRemote } from './jsc';
import { buildWasmModule, type WasmImportSource } from './wasm';
import type { OxcTranspiler } from './oxc';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
const CTS_INTERNAL = Symbol.for('cts.internal');
const CTS_REQUIRE_GETTER = Symbol.for('cts.require.getter');

export class ModuleLoader {
    private readonly transformer: Transformer;
    private readonly cjs:        CjsLoader;
    private readonly esmCache    = new Map<string, CModuleEngine.Module>();
    /** Modules currently being compiled (circular dep detection). */
    private readonly esmLoading  = new Set<string>();
    private readonly wasmCache   = new Map<string, CModuleEngine.Module>();
    readonly jsc:                JscCache;

    /** Track all loaded modules for proper cleanup */
    private readonly loadedModules = new Set<CModuleEngine.Module>();

    setOxc(oxc: OxcTranspiler): void {
        this.transformer.setOxc(oxc);
    }

    constructor(
        private readonly resolver: ModuleResolver,
        private readonly cfg:      RuntimeConfig,
    ) {
        this.jsc = new JscCache(cfg.cacheDir);
        this.transformer = new Transformer({
            sourceMaps: true,
            jsxPragma: cfg.jsxPragma,
            jsxFragmentPragma: cfg.jsxFragmentPragma,
        });
        this.cjs = new CjsLoader(this.buildCjsDeps());

        this.installGlobalRequire();
        this.installInternalBridge();
    }

    /** Clean up loaded modules when no longer needed */
    clearLoadedModules(): void {
        this.esmCache.clear();
        this.wasmCache.clear();
    }

    /** True if any module is currently being loaded (esmLoading or wasmLoading). */
    hasPendingLoads(): boolean {
        return this.esmLoading.size > 0 || this.wasmLoading.size > 0;
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

    requireInternal(id: string, parentPath = `${os.cwd}/<internal>`): any {
        return this.cjs.mkRequire(parentPath)(id);
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
            this.loadedModules.add(placeholder);
            return placeholder;
        }

        const remote = isRemote(info.specPath);
        const needsTransform = !remote && /\.(?:tsx?|jsx)$/.test(info.localPath);
        const needsCompile  = !remote && !needsTransform && /\.(?:m?js)$/.test(info.localPath);
        const cacheable = !this.cfg.disableCache && (remote || needsTransform || needsCompile);

        // 1) JSC cache: in-memory (from precompile) → on-disk .jsc
        if (cacheable) {
            const cached = this.jsc.load(info.localPath, remote, this.resolver.getCachedMtime(info.localPath));
            if (cached) {
                Object.assign(cached.meta, meta);
                this.esmCache.set(info.localPath, cached);
                this.loadedModules.add(cached);
                return cached;
            }
        }

        // 2) Fallback: read + transform + compile on main thread
        this.esmLoading.add(info.localPath);
        const text = readText(info.localPath);
        const code = this.transformer.transform(text, info.localPath, meta?.lang);
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

        // If a placeholder was created during circular resolution, populate it
        // with the real exports now that the module is compiled. Modules that
        // received the placeholder during the cycle hold a reference to it and
        // will see the populated exports (live-binding semantics).
        const cached = this.esmCache.get(info.localPath);
        if (cached && cached !== mod) {
            const ns = mod.namespace;
            for (const key of Object.keys(ns)) {
                try { cached.export(key, ns[key]); } catch { /* ok */ }
            }
            log.debug('loader', () => `populated ESM placeholder: ${info.specPath} (${Object.keys(ns).length} exports)`);
            return cached;
        }

        if (cacheable) {
            if (remote) this.jsc.persist(info.localPath, mod);
            else        this.jsc.persistLocal(info.localPath, mod);
        }

        Object.assign(mod.meta, meta);
        this.esmCache.set(info.localPath, mod);
        this.loadedModules.add(mod);
        return mod;
    }

    private loadEsmSource(code: string, info: ModuleInfo, meta: Record<string, any>): CModuleEngine.Module {
        const hit = this.esmCache.get(info.localPath);
        if (hit) {
            if (meta.main !== undefined) (hit.meta as Record<string, any>).main = meta.main;
            return hit;
        }
        const transformed = this.transformer.transform(code, info.localPath, meta?.lang);
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
        this.loadedModules.add(mod);
        return mod;
    }

    private loadCjsSource(code: string, info: ModuleInfo, meta: Record<string, any>): CModuleEngine.Module {
        const transformed = this.transformer.transform(code, info.localPath, meta?.lang);
        const cjsMod = this.cjs.loadSourceAndGet(transformed, info.localPath);
        return this.bridgeCjsToEsm(info, meta, cjsMod.exports);
    }

    private loadTextSource(code: string, info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(info.specPath);
        mod.export('default', code);
        this.loadedModules.add(mod);
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

        this.loadedModules.add(mod);
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
            this.loadedModules.add(placeholder);
            return placeholder;
        }

        this.wasmLoading.add(info.localPath);

        const importSource: WasmImportSource = {
            require: (spec, parentPath) => {
                const resolved = this.resolver.resolve(spec, parentPath);
                const loaded = this.load(resolved, {});
                loaded.eval();
                const ns = loaded.namespace;
                log.debug('wasm', () => `import "${spec}" resolved → ${resolved.specPath} (${Object.keys(ns).length} exports)`);
                return ns;
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
        this.loadedModules.add(result.mod);
        return result.mod;
    }

    private loadBytes(info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(info.specPath);
        mod.export('default', new Uint8Array(fs.readFile(info.localPath)));
        this.loadedModules.add(mod);
        return mod;
    }

    private loadText(info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(info.specPath);
        mod.export('default', readText(info.localPath));
        this.loadedModules.add(mod);
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

            resolveExternal(req: string, parent: string): { path: string; specPath: string; isCjs: boolean } | null {
                try {
                    const info = self.resolver.resolve(req, parent, { cjs: true });
                    return {
                        path: info.localPath,
                        specPath: info.specPath,
                        isCjs: info.format === 'cjs' || info.fileKind === 'json',
                    };
                } catch { return null; }
            },
        };
    }

    private installGlobalRequire(): void {
        let requireFn: Function | undefined;
        const getter = () => {
            if (!requireFn) requireFn = this.cjs.mkRequire(this.resolver.entry);
            return requireFn;
        };

        const desc = Object.getOwnPropertyDescriptor(globalThis, 'require');
        if (!desc) {
            Object.defineProperty(globalThis, 'require', {
                get: getter,
                enumerable: true,
                configurable: true,
            });
            Reflect.set(globalThis, CTS_REQUIRE_GETTER, getter);
            return;
        }

        if (desc.configurable) {
            Object.defineProperty(globalThis, 'require', {
                get: getter,
                enumerable: desc.enumerable ?? true,
                configurable: true,
            });
            Reflect.set(globalThis, CTS_REQUIRE_GETTER, getter);
        }
    }

    private installInternalBridge(): void {
        const value = {
            mkRequire: this.cjs.mkRequire.bind(this.cjs),
            builtinModules: [...BUILTINS],
            cache: this.cjs.cache,
        };
        const desc = Object.getOwnPropertyDescriptor(globalThis, CTS_INTERNAL);
        if (!desc) {
            Object.defineProperty(globalThis, CTS_INTERNAL, {
                value,
                writable: false,
                enumerable: false,
                configurable: false,
            });
            return;
        }
        if ('value' in desc && desc.value && typeof desc.value === 'object') {
            try {
                (desc.value as any).mkRequire = value.mkRequire;
                (desc.value as any).builtinModules = value.builtinModules;
                (desc.value as any).cache = value.cache;
            } catch {}
        }
    }
}
