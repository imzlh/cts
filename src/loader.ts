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
        const hint = hintOf(info.specPath);
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
            // Only `main` can change between cache hits; skip full assign
            if (meta.main !== undefined) (hit.meta as Record<string, any>).main = meta.main;
            return hit;
        }

        const cacheable = !this.cfg.disableCache
            && info.localPath.startsWith(this.cfg.cacheDir);
        const jscPath   = info.localPath + '.jsc';

        if (cacheable) {
            const isRemote = !info.specPath.startsWith('file://');
            const cached   = tryReadJsc(jscPath, info.localPath, isRemote);
            if (cached) {
                Object.assign(cached.meta, meta);
                this.esmCache.set(info.localPath, cached);
                store.push(cached);
                return cached;
            }
        }

        log.debug('loader', () => `load ${info.specPath} ${JSON.stringify(meta)}`);
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
        const inst = new wasm.Instance(
            new wasm.Module(new Uint8Array(fs.readFile(info.localPath))), {});
        const mod  = engine.Module.create(info.specPath);
        for (const k of Object.keys(inst.exports)) mod.export(k, inst.exports[k]);
        store.push(mod);
        return mod;
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
                    const info = self.resolver.resolve(req, parent);
                    return { path: info.localPath, isCjs: info.format === 'cjs' };
                } catch { return null; }
            },
        };
    }
}
