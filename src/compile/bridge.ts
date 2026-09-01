import { type ModuleInfo } from '../types';
import type { CjsCacheStore, CjsDeps, CjsRequireFn } from './cjs';
import type { EsmCompiler } from './esm';
import type { ModuleResolver } from '../resolve/index';
import { isResolutionMiss, requireCycleError } from '../errors';
import { BUILTINS } from '../resolve/builtins';
import { errMsg, log } from '../utils';
import type { NodeModuleInteropBridge } from './node-interop';
import {
    hasModuleLoadHooks,
    hasModuleResolveHooks,
    registerModuleHooks,
    runModuleLoadHooks,
    runModuleResolveHooks,
} from '../module-hooks';

const engine = import.meta.use('engine');

const CTS_INTERNAL = Symbol.for('cts.internal');
const CTS_REQUIRE_GETTER = Symbol.for('cts.require.getter');
let cjsBridgeId = 0;

/** Package name end in npm body: after scope for @scope/name, else first /. */
function npmBodyNameEnd(body: string): number {
    if (body.startsWith('@')) {
        const scopeSlash = body.indexOf('/');
        if (scopeSlash <= 1) return -1;
        const next = body.indexOf('/', scopeSlash + 1);
        return next === -1 ? body.length : next;
    }
    const slash = body.indexOf('/');
    return slash === -1 ? body.length : slash;
}

function buildCjsEsmWrapper(specPath: string, exports: Record<string, unknown>): CModuleEngine.Module {
    const slot = `__cts_cjs_bridge_${cjsBridgeId++}`;
    Reflect.set(globalThis, slot, exports);

    let code = `const __cts = globalThis[${JSON.stringify(slot)}];\n`;
    let index = 0;
    for (const key of Object.keys(exports)) {
        const local = `__cts_export_${index++}`;
        code += `const ${local} = __cts[${JSON.stringify(key)}];\n`;
        if (key === 'default') {
            code += `export default ${local};\n`;
        } else {
            // Arbitrary module export names (ES2022): reserved words, spaces, quotes.
            code += `export { ${local} as ${JSON.stringify(key)} };\n`;
        }
    }
    code += `delete globalThis[${JSON.stringify(slot)}];\n`;
    return new engine.Module(code, specPath);
}

// ESM -> CJS bridge: wrap CJS exports as an ESM Module

/** ESM Module from CJS exports; honors __esModule. */
export function bridgeCjsToEsm(
    specPath: string,
    meta: Record<string, unknown>,
    exports: unknown,
): CModuleEngine.Module {
    const out: Record<string, unknown> = Object.create(null);

    const exportRecord = exports !== null && (typeof exports === 'object' || typeof exports === 'function')
        ? exports
        : null;

    // Node adds a 'module.exports' named export to every CJS wrap; a real key of
    // that name wins because the loops below run after this assignment.
    out['module.exports'] = exports;

    if (exportRecord
        && Reflect.get(exportRecord, '__esModule') === true
        && Object.prototype.hasOwnProperty.call(exportRecord, 'default')) {
        // CTS deliberately unwraps transpiler-created default exports.
        for (const k of Object.keys(exportRecord)) {
            if (k !== '__esModule') out[k] = Reflect.get(exportRecord, k);
        }
        out.__esModule = true;
    } else {
        // True CJS defaults to the complete exports object.
        if (exportRecord) {
            for (const k of Object.keys(exportRecord)) {
                if (k !== 'default') out[k] = Reflect.get(exportRecord, k);
            }
            // Node exposes __esModule as a named export when present.
            if (Reflect.get(exportRecord, '__esModule') === true) out.__esModule = true;
        }
        out.default = exports;
    }

    const mod = buildCjsEsmWrapper(specPath, out);
    Object.assign(mod.meta, meta);
    return mod;
}

// CJS -> ESM bridge: synchronously load ESM via promiseResult

/** Sync ESM for require(): throw → error; null → TLA (reject); else namespace. */
export function loadEsmSync(
    info: ModuleInfo,
    esm: EsmCompiler,
    resolveMtime?: (p: string) => number | undefined,
    from = '<unknown>',
): Record<string, unknown> {
    // Never expose or evaluate a partial in-flight ESM namespace to require().
    if (esm.isInFlight(info.localPath)) {
        throw requireCycleError(info.localPath, from, 'require-esm');
    }

    const mod = esm.load(info, {}, resolveMtime);
    const result = engine.promiseResult(esm.trackEvaluation(info.localPath, () => mod.eval()));

    // null = top-level await unresolved; do NOT weaken with namespace check (causes silent dead-lock)
    if (result === null) {
        // Node: ERR_REQUIRE_ASYNC_MODULE
        const e = new Error(
            `Cannot require() async ESM module '${info.specPath}'; use dynamic import() instead`
        ) as Error & { code?: string };
        e.code = 'ERR_REQUIRE_ASYNC_MODULE';
        throw e;
    }

    return mod.namespace;
}

// CjsDeps factory: wire CjsLoader to resolver + ESM compiler

/** Wire CjsLoader to resolver + ESM compiler. */
export function buildCjsDeps(
    resolver: ModuleResolver,
    esm: EsmCompiler,
    loadWasmSync?: (info: ModuleInfo) => Record<string, unknown>,
): CjsDeps {
    return {
        resolveBuiltin(name: string, parent: string): ModuleInfo {
            return resolver.resolve(`node:${name}`, parent);
        },

        loadEsmSync(info: ModuleInfo, from?: string): Record<string, unknown> {
            return loadEsmSync(info, esm, undefined, from);
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

        /**
         * Inspection-only twin of resolveExternal, for require.resolve().
         * Never fetches or installs — see ModuleResolver.resolveForInspection
         * for the full reasoning and the measurements behind it.
         *
         * Miss handling differs from resolveExternal on purpose: under no-fetch,
         * a store miss surfaces as the cachedOnly-specific ModuleNotFound
         * ("npm package not found in cache: …, --cached-only is specified"),
         * which IS the right answer for an inspection and must become a plain
         * miss so require.resolve() reports node's MODULE_NOT_FOUND rather than
         * leaking a --cached-only message the user never opted into.
         */
        resolveExternalCached(req: string, parent: string): ModuleInfo | null {
            try {
                return resolver.resolveForInspection(req, parent, { cjs: true });
            } catch (e) {
                if (isResolutionMiss(e)) return null;
                throw e;
            }
        },

        prepareSource(code: string, filePath: string): string | null {
            return esm.transformer.transformForCjs(code, filePath);
        },

        loadCjsCompiled(localPath: string): unknown | null {
            return esm.jsc.loadCompiled(localPath, false, undefined, localPath);
        },

        takeSourceSnapshot(localPath: string) {
            return esm.jsc.takeSourceSnapshot(localPath, localPath);
        },

        persistCjsCompiled(localPath: string, bytes: ArrayBuffer, source): void {
            esm.jsc.persistBytecode(localPath, bytes, false, localPath, source);
        },

        captureSourceFreshness(localPath: string) {
            return esm.jsc.captureFreshness(localPath);
        },

        runtimeParent(localPath: string): string | null {
            return resolver.packParentRef(localPath);
        },
    };
}

// Global require + CTS_INTERNAL installation

/** Normalize path traversal (../..) in npm subpaths (scoped names keep @scope/pkg). */
function normalizeNpmSpec(spec: string): string {
    if (!spec.startsWith('npm:')) return spec;
    const body = spec.slice(4);
    const nameEnd = npmBodyNameEnd(body);
    if (nameEnd < 0 || nameEnd >= body.length) return spec;
    // nameEnd points at '/' after package name (or body end if bare package).
    const pkg = body.slice(0, nameEnd);
    if (body.charCodeAt(nameEnd) !== 47) return spec;
    const normalized: string[] = [];
    let start = nameEnd + 1;
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

/** Lazy globalThis.require; re-install warns (one runtime per process). */
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

/** Install/overwrite globalThis[CTS_INTERNAL] bridge fields. */
export function installInternalBridge(
    mkRequire: (parentPath: string) => CjsRequireFn,
    preloadModule: (id: string, parentPath: string) => unknown,
    cache: CjsCacheStore,
    resolver: ModuleResolver,
    cacheControl?: {
        replaceCache(value: Record<string, unknown>): void;
        resetCache(value?: Record<string, unknown>): void;
        replaceExtensions(value: Record<string, unknown>): void;
        resetExtensions(): void;
    },
): void {
    const existingDesc = Object.getOwnPropertyDescriptor(globalThis, CTS_INTERNAL);
    const existingValue = existingDesc && 'value' in existingDesc && existingDesc.value &&
        typeof existingDesc.value === 'object'
        ? existingDesc.value as { nodeModuleInterop?: NodeModuleInteropBridge }
        : undefined;
    // Cached node:module copies retain this identity across runtime installs.
    const nodeModuleInterop = existingValue?.nodeModuleInterop ?? {};
    if (cacheControl) {
        nodeModuleInterop.replaceCache = cacheControl.replaceCache;
        nodeModuleInterop.resetCache = cacheControl.resetCache;
        nodeModuleInterop.replaceExtensions = cacheControl.replaceExtensions;
        nodeModuleInterop.resetExtensions = cacheControl.resetExtensions;
        const nodeCache = nodeModuleInterop.getCache?.();
        if (nodeCache !== undefined) {
            if (nodeModuleInterop.cacheIsDefault?.()) cacheControl.resetCache();
            else cacheControl.replaceCache(nodeCache);
        }
        const nodeExtensions = nodeModuleInterop.getExtensions?.();
        if (nodeExtensions !== undefined) {
            if (nodeModuleInterop.extensionsAreDefault?.()) cacheControl.resetExtensions();
            else cacheControl.replaceExtensions(nodeExtensions);
        }
    }
    const value = {
        mkRequire,
        preloadModule,
        builtinModules: [...BUILTINS],
        cache,
        registerModuleHooks,
        hasModuleResolveHooks,
        hasModuleLoadHooks,
        runModuleResolveHooks,
        runModuleLoadHooks,
        nodeModuleInterop,
        specToLocalPath(specPath: string): string | null {
            const normalized = normalizeNpmSpec(specPath);
            try {
                const info = resolver.getInfo(normalized);
                return info?.localPath ?? null;
            } catch { return null; }
        },
    };
    const desc = existingDesc;
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
