// compile/bridge.ts — CJS <-> ESM interop bridge
//
// Responsibilities:
//   - bridgeCjsToEsm: wrap CJS exports as ESM Module (for ESM importing CJS)
//   - loadEsmSync: synchronously load ESM for CJS require() (promiseResult semantics)
//   - installGlobalRequire: install require() on globalThis
//   - installInternalBridge: install CTS_INTERNAL symbol on globalThis
//   - buildCjsDeps: construct the CjsDeps callback interface

import type { ModuleInfo } from '../types';
import type { CjsDeps } from './cjs';
import type { EsmCompiler } from './esm';
import type { ModuleResolver } from '../resolve/index';
import { BUILTINS } from '../resolve/builtins';

const engine = import.meta.use('engine');

const CTS_INTERNAL = Symbol.for('cts.internal');
const CTS_REQUIRE_GETTER = Symbol.for('cts.require.getter');

// ---------------------------------------------------------------------------
// ESM -> CJS bridge: wrap CJS exports as an ESM Module
// ---------------------------------------------------------------------------

/**
 * Create an ESM Module from CJS module.exports.
 * Handles __esModule flag (Babel/tsc transpiled modules).
 */
export function bridgeCjsToEsm(
    specPath: string,
    meta: Record<string, any>,
    exports: any,
): CModuleEngine.Module {
    const mod = engine.Module.create(specPath);
    Object.assign(mod.meta, meta);

    if (exports !== null && typeof exports === 'object' && exports.__esModule === true) {
        // Babel/tsc transpiled: each key is a named export, default comes from exports.default
        for (const k of Object.keys(exports)) {
            if (k !== '__esModule') mod.export(k, exports[k]);
        }
        if (!Object.prototype.hasOwnProperty.call(exports, 'default')) {
            mod.export('default', undefined);
        }
    } else {
        // True CJS: each key is a named export, default is the whole exports object
        if (exports !== null && typeof exports === 'object') {
            for (const k of Object.keys(exports)) {
                if (k !== 'default') mod.export(k, exports[k]);
            }
        }
        mod.export('default', exports);
    }

    return mod;
}

// ---------------------------------------------------------------------------
// CJS -> ESM bridge: synchronously load ESM via promiseResult
// ---------------------------------------------------------------------------

/**
 * Load an ESM module synchronously for CJS require() interop.
 *
 * promiseResult semantics:
 *   1. Throws  -> module evaluation failed (SyntaxError, etc.) -> propagate as require error
 *   2. Returns null -> module has top-level await, cannot load synchronously
 *   3. Returns truthy -> module loaded successfully -> safe to read namespace
 *
 * After success, iterates namespace keys with try/catch to guard against
 * getters that may throw (async leftover side-effects).
 */
export function loadEsmSync(
    info: ModuleInfo,
    esm: EsmCompiler,
    resolveMtime?: (p: string) => number | undefined,
): Record<string, any> {
    const mod = esm.load(info, {}, resolveMtime);
    const p = mod.eval();

    const result = engine.promiseResult(p);

    // Case 1: error thrown during evaluation → propagate
    // (promiseResult re-throws the error)

    // Case 2: null → module has top-level await, cannot load synchronously
    if (result === null && Object.keys(mod.namespace).length === 0) {
        throw new Error(
            `Cannot require() async ESM module '${info.specPath}'; use dynamic import() instead`
        );
    }

    // Case 3: return the full namespace.
    return mod.namespace;
}

// ---------------------------------------------------------------------------
// CjsDeps factory: wire CjsLoader to resolver + ESM compiler
// ---------------------------------------------------------------------------

/**
 * Build the CjsDeps callback interface that CjsLoader uses
 * to interact with the resolver and ESM compiler.
 */
export function buildCjsDeps(
    resolver: ModuleResolver,
    esm: EsmCompiler,
): CjsDeps {
    return {
        builtinToPath(name: string, parent: string): string {
            return resolver.resolve(`node:${name}`, parent).localPath;
        },

        loadEsmSync(localPath: string, specPath: string): Record<string, any> {
            let info: ModuleInfo;
            try {
                info = resolver.getInfo(specPath);
            } catch {
                info = { specPath, localPath, format: 'esm', fileKind: 'source' };
            }
            return loadEsmSync(info, esm, (p) => resolver.getCachedMtime(p));
        },

        resolveExternal(req: string, parent: string): { path: string; specPath: string; isCjs: boolean } | null {
            try {
                const info = resolver.resolve(req, parent, { cjs: true });
                return {
                    path: info.localPath,
                    specPath: info.specPath,
                    isCjs: info.format === 'cjs' || info.fileKind === 'json',
                };
            } catch { return null; }
        },

        prepareSource(code: string, filePath: string): string | null {
            return esm.transformer.transformForCjs(code, filePath);
        },
    };
}

// ---------------------------------------------------------------------------
// Global require + CTS_INTERNAL installation
// ---------------------------------------------------------------------------

/** Normalize path traversal (../..) in npm spec paths. */
function normalizeNpmSpec(spec: string): string {
    if (!spec.startsWith('npm:')) return spec;
    const body = spec.slice(4);
    const slash = body.indexOf('/');
    if (slash === -1) return spec;
    const pkg = body.slice(0, slash);
    const parts = body.slice(slash + 1).split('/');
    const normalized: string[] = [];
    for (const p of parts) {
        if (p === '.' || p === '') continue;
        if (p === '..') { normalized.pop(); continue; }
        normalized.push(p);
    }
    return normalized.length > 0 ? `npm:${pkg}/${normalized.join('/')}` : `npm:${pkg}`;
}

/**
 * Install globalThis.require as a lazy getter that delegates to CjsLoader.
 */
export function installGlobalRequire(
    mkRequire: (parentPath: string) => any,
    getEntry: () => string,
): void {
    let requireFn: Function | undefined;
    let cachedEntry = '';
    const getter = () => {
        const entry = getEntry();
        if (!requireFn || entry !== cachedEntry) {
            cachedEntry = entry;
            requireFn = mkRequire(entry);
        }
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

/**
 * Install globalThis[Symbol.for('cts.internal')] bridge
 * exposing mkRequire, builtinModules, cache, specToLocalPath.
 */
export function installInternalBridge(
    mkRequire: (parentPath: string) => any,
    cache: Map<string, any>,
    resolver: ModuleResolver,
): void {
    const value = {
        mkRequire,
        builtinModules: [...BUILTINS],
        cache,
        specToLocalPath(specPath: string): string | null {
            const normalized = normalizeNpmSpec(specPath);
            try {
                const info = resolver.getInfo(normalized);
                return info?.localPath ?? null;
            } catch { return null; }
        },
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
            (desc.value as any).specToLocalPath = value.specToLocalPath;
        } catch {}
    }
}
