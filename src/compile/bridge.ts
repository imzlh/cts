import type { ModuleInfo } from '../types';
import type { CjsDeps, CjsRequireFn } from './cjs';
import type { EsmCompiler } from './esm';
import type { ModuleResolver } from '../resolve/index';
import { isResolutionMiss } from '../errors';
import { BUILTINS } from '../resolve/builtins';
import { errMsg, log } from '../utils';

const engine = import.meta.use('engine');

const CTS_INTERNAL = Symbol.for('cts.internal');
const CTS_REQUIRE_GETTER = Symbol.for('cts.require.getter');
let cjsBridgeId = 0;

function buildCjsEsmWrapper(specPath: string, exports: Record<string, unknown>): CModuleEngine.Module {
    const slot = `__cts_cjs_bridge_${cjsBridgeId++}`;
    Reflect.set(globalThis, slot, exports);

    let code = `const __cts = globalThis[${JSON.stringify(slot)}];\n`;
    let index = 0;
    for (const key of Object.keys(exports)) {
        const local = `__cts_export_${index++}`;
        code += `const ${local} = __cts[${JSON.stringify(key)}];\n`;
        code += key === 'default'
            ? `export default ${local};\n`
            : `export { ${local} as ${JSON.stringify(key)} };\n`;
    }
    code += `delete globalThis[${JSON.stringify(slot)}];\n`;
    return new engine.Module(code, specPath);
}

// ---------------------------------------------------------------------------
// ESM -> CJS bridge: wrap CJS exports as an ESM Module
// ---------------------------------------------------------------------------

/**
 * Create an ESM Module from CJS module.exports.
 * Handles __esModule flag (Babel/tsc transpiled modules).
 */
export function bridgeCjsToEsm(
    specPath: string,
    meta: Record<string, unknown>,
    exports: unknown,
): CModuleEngine.Module {
    const out: Record<string, unknown> = Object.create(null);

    const exportRecord = exports !== null && (typeof exports === 'object' || typeof exports === 'function')
        ? exports
        : null;

    if (exportRecord && Reflect.get(exportRecord, '__esModule') === true) {
        // Babel/tsc transpiled: each key is a named export, default comes from exports.default
        for (const k of Object.keys(exportRecord)) {
            if (k !== '__esModule') out[k] = Reflect.get(exportRecord, k);
        }
        if (!Object.prototype.hasOwnProperty.call(exportRecord, 'default')) {
            out.default = undefined;
        }
    } else {
        // True CJS: each key is a named export, default is the whole exports object
        if (exportRecord) {
            for (const k of Object.keys(exportRecord)) {
                if (k !== 'default') out[k] = Reflect.get(exportRecord, k);
            }
        }
        if (!exportRecord || !Object.prototype.hasOwnProperty.call(exportRecord, 'module.exports')) {
            out['module.exports'] = exports;
        }
        out.default = exports;
    }

    const mod = buildCjsEsmWrapper(specPath, out);
    Object.assign(mod.meta, meta);
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
): Record<string, unknown> {
    const mod = esm.load(info, {}, resolveMtime);
    const result = engine.promiseResult(mod.eval());

    // null = top-level await unresolved; do NOT weaken with namespace check (causes silent dead-lock)
    if (result === null) {
        throw new Error(
            `Cannot require() async ESM module '${info.specPath}'; use dynamic import() instead`
        );
    }

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
    loadWasmSync?: (info: ModuleInfo) => Record<string, unknown>,
): CjsDeps {
    return {
        resolveBuiltin(name: string, parent: string): ModuleInfo {
            return resolver.resolve(`node:${name}`, parent);
        },

        loadEsmSync(info: ModuleInfo): Record<string, unknown> {
            return loadEsmSync(info, esm, (p) => resolver.getCachedMtime(p));
        },

        loadWasmSync,

        resolveExternal(req: string, parent: string): ModuleInfo | null {
            try {
                return resolver.resolve(req, parent, { cjs: true });
            } catch (e) {
                // Only true misses fall through to CJS local FS; policy/network
                // errors must surface (was: catch { return null } → wrong MODULE_NOT_FOUND).
                if (isResolutionMiss(e)) return null;
                throw e;
            }
        },

        prepareSource(code: string, filePath: string): string | null {
            return esm.transformer.transformForCjs(code, filePath);
        },

        loadCjsCompiled(localPath: string): unknown | null {
            return esm.jsc.loadCompiled(localPath, false);
        },

        persistCjsCompiled(localPath: string, bytes: ArrayBuffer): void {
            esm.jsc.persistBytecode(localPath, bytes, false);
        },

        runtimeParent(localPath: string): string | null {
            return resolver.packParentRef(localPath);
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
    const normalized: string[] = [];
    let start = slash + 1;
    for (let i = start; i <= body.length; i++) {
        if (i !== body.length && body.charCodeAt(i) !== 47) continue;
        const len = i - start;
        if (len === 0 || (len === 1 && body.charCodeAt(start) === 46)) {
            start = i + 1;
            continue;
        }
        if (len === 2 && body.charCodeAt(start) === 46 && body.charCodeAt(start + 1) === 46) {
            normalized.pop();
        } else {
            normalized.push(body.slice(start, i));
        }
        start = i + 1;
    }
    return normalized.length > 0 ? `npm:${pkg}/${normalized.join('/')}` : `npm:${pkg}`;
}

/**
 * Install globalThis.require as a lazy getter that delegates to CjsLoader.
 * Warns on re-install (second runtime in same process hijacks the first).
 */
export function installGlobalRequire(
    mkRequire: (parentPath: string) => (id: string) => unknown,
    getEntry: () => string,
): void {
    const prev = Reflect.get(globalThis, CTS_REQUIRE_GETTER);
    if (prev) log.warn('bridge', () => 'globalThis.require re-installed — prior runtime hijacked');

    let requireFn: ((id: string) => unknown) | undefined;
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
            get: getter, enumerable: true, configurable: true,
        });
        Reflect.set(globalThis, CTS_REQUIRE_GETTER, getter);
        return;
    }

    if (desc.configurable) {
        Object.defineProperty(globalThis, 'require', {
            get: getter, enumerable: desc.enumerable ?? true, configurable: true,
        });
        Reflect.set(globalThis, CTS_REQUIRE_GETTER, getter);
    }
}

/**
 * Install globalThis[CTS_INTERNAL] bridge.
 * Re-install overwrites the prior object's fields (with per-field error logging).
 */
export function installInternalBridge(
    mkRequire: (parentPath: string) => CjsRequireFn,
    preloadModule: (id: string, parentPath: string) => unknown,
    cache: Map<string, unknown>,
    resolver: ModuleResolver,
): void {
    const value = {
        mkRequire,
        preloadModule,
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
            value, writable: false, enumerable: false, configurable: false,
        });
        return;
    }
    if ('value' in desc && desc.value && typeof desc.value === 'object') {
        log.warn('bridge', () => 'CTS_INTERNAL re-installed — prior runtime hijacked');
        for (const [k, v] of Object.entries(value)) {
            try { Reflect.set(desc.value, k, v); }
            catch (e) { log.debug('bridge', () => `CTS_INTERNAL field "${k}" overwrite failed: ${errMsg(e)}`); }
        }
    }
}
