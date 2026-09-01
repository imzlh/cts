import { moduleRef, type ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import type { ModuleCompiler } from '../compile/index';
import { fillMeta, isProtocolSpec, resolveWithModuleHooks, toFileUrl } from './meta';
import { errMsg, isRelative, joinPaths, dirname, log } from '../utils';
import { URL } from '../utils/url';
import { err, ErrorKind, isErrorKind, setErrorCode } from '../errors';

const engine = import.meta.use('engine');

const SUPPORTED_ATTRS = new Set(['type', 'raw', 'text', 'bytes']);
let activeInstall = false;

function unknownAttrNames(attr: Record<string, unknown>): string {
    let out = '';
    for (const key in attr) {
        if (SUPPORTED_ATTRS.has(key)) continue;
        if (out) out += ', ';
        out += key;
    }
    return out;
}

function unsupportedAttribute(name: string, value: unknown): TypeError {
    const error = new TypeError(`Import attribute "${name}" with value "${String(value)}" is not supported`);
    Object.defineProperty(error, 'code', { value: 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED' });
    return error;
}

export interface EngineHookCallbacks {
    onInitHook?: (specPath: string, info: ModuleInfo) => void;
    onSyntaxError?: (e: SyntaxError) => never;
}

export interface EngineHooks {
    clearLoadedModules(): void;
}

function hasSyntaxSourceCause(error: SyntaxError): boolean {
    const cause = Reflect.get(error, 'cause');
    return !!cause && typeof cause === 'object' && Reflect.get(cause, 'source') instanceof SyntaxError;
}

/** The URL node reports on a failed `import()`, or undefined when node omits it.
 *
 *  Measured against node v24.18.0: `url` is present exactly when the specifier
 *  named a *location* — an absolute file URL, or a relative path resolved
 *  against the importer — and absent when it named a *package*:
 *
 *    import('file:///D:/no/such/x.mjs')  → url 'file:///D:/no/such/x.mjs'
 *    import('./missing.mjs')            → url of the resolved absolute path
 *    import('no-such-pkg')              → no url ("Cannot find package …")
 *
 *  So a bare specifier returns undefined here rather than a fabricated URL. */
function importUrlFor(spec: string, parent: string): string | undefined {
    // Already a URL (file:, http:, data:, npm:, pack:, …) — node echoes it back.
    if (spec.includes('://') || isProtocolSpec(spec)) return spec;
    if (isRelative(spec)) {
        // Resolve against the importer, which may itself be a URL or a path.
        if (parent.includes('://') || isProtocolSpec(parent)) {
            try { return new URL(spec, parent).toString(); } catch { return undefined; }
        }
        if (!parent) return undefined;
        return toFileUrl(joinPaths(dirname(parent), spec));
    }
    // Absolute path (no scheme) — still a location, not a package.
    if (spec.startsWith('/') || /^[A-Za-z]:[/\\]/.test(spec)) return toFileUrl(spec);
    // Bare specifier: node sets no url.
    return undefined;
}

/** Give a failed `import()` the shape node gives it: ERR_MODULE_NOT_FOUND plus
 *  a `url`. Node uses two different codes for the same miss depending on the
 *  loader — `require()` reports MODULE_NOT_FOUND (which is what codeForKind
 *  hands out, and what cno already got right), while `import()` reports
 *  ERR_MODULE_NOT_FOUND. This is the import side, so it upgrades.
 *
 *  A more specific code already on the inner error wins: pkg.ts raises
 *  ERR_PACKAGE_PATH_NOT_EXPORTED and resolve/protocols/node.ts raises
 *  ERR_UNKNOWN_BUILTIN_MODULE, both of which node also reports in preference to
 *  a generic not-found. Only the two default resolution-miss codes get
 *  overwritten, so anything ERR_-prefixed is treated as deliberate.
 *
 *  Exported for tests/cts/import-error-code.test.ts — cts/src is baked into the
 *  binary, so the unit is the only layer where this is verifiable pre-rebuild. */
export function esmResolveError(spec: string, parent: string, cause: unknown, kind: ErrorKind): Error {
    const inner = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
    const specific = typeof inner === 'string' && inner.startsWith('ERR_') ? inner : undefined;
    const isMiss = kind === ErrorKind.ModuleNotFound || kind === ErrorKind.FileNotFound;
    const e = err(kind, `Cannot resolve "${spec}" from "${parent}": ${errMsg(cause)}`, cause);
    if (specific) setErrorCode(e, specific);
    else if (isMiss) setErrorCode(e, 'ERR_MODULE_NOT_FOUND');
    if (isMiss && !specific) {
        const url = importUrlFor(spec, parent);
        if (url !== undefined) {
            Object.defineProperty(e, 'url', {
                value: url, writable: true, enumerable: true, configurable: true,
            });
        }
    }
    return e;
}

/** Install onModule hooks (C layer replaces; re-install warns). */
export function installEngineHooks(
    resolver: ModuleResolver,
    compiler: ModuleCompiler,
    callbacks: EngineHookCallbacks = {},
    expectedReplacement = false,
): EngineHooks {
    if (activeInstall && !expectedReplacement) log.warn('runtime', () => 'engine.onModule re-installed — prior runtime hooks replaced');
    activeInstall = true;

    // Dedup: QuickJS does not cache dynamic import() results, so the
    // same runtime module ref may arrive multiple times.
    const loadedModules = new Map<string, CModuleEngine.Module>();

    engine.onModule({
        resolve(spec: string, parent: string, attr?: Record<string, unknown>): string {
            try {
                const info = resolveWithModuleHooks(resolver, spec, parent, attr);
                // CJS circular stubs only — ESM/pack preRegister is pure waste
                // (buildPaths walks synthetic pack: keys toward root).
                if (info.format === 'cjs' && info.fileKind === 'source') {
                    compiler.preRegister(info.localPath, parentLocal(parent));
                }
                return moduleRef(info);
            } catch (e) {
                const code = e instanceof Error ? Reflect.get(e, 'code') : undefined;
                if (code === 'ERR_IMPORT_ATTRIBUTE_UNSUPPORTED'
                    || code === 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE') throw e;
                // Preserve LockFrozen / ProtocolDisabled / NetworkError / … —
                // rewriting everything as ModuleNotFound hid real failure kinds.
                // Reject non-enum .kind (garbage numbers would poison formatError).
                const kind = e instanceof Error && isErrorKind(e.kind)
                    ? e.kind
                    : ErrorKind.ModuleNotFound;
                throw esmResolveError(spec, parent, e, kind);
            }
        },

        load(specPath: string): CModuleEngine.Module {
            log.debug('runtime', () => `load hook: ${specPath}`);
            const info = resolver.getInfo(specPath);
            const key = moduleKey(info);
            // Dedup before fillMeta — dynamic import() may re-enter often.
            const dedup = loadedModules.get(key);
            if (dedup) return dedup;

            const meta: Record<string, unknown> = {};
            fillMeta(meta, info, resolver);
            try {
                const mod = compiler.load(info, meta);
                loadedModules.set(key, mod);
                return mod;
            } catch (e) {
                if (e instanceof SyntaxError && hasSyntaxSourceCause(e) && callbacks.onSyntaxError) {
                    callbacks.onSyntaxError(e);
                }
                throw e;
            }
        },

        init(specPath: string, importMeta: Record<string, unknown>): void {
            log.debug('runtime', () => `init hook: ${specPath}`);
            const info = resolver.getInfo(specPath);
            fillMeta(importMeta, info, resolver);
            callbacks.onInitHook?.(info.specPath, info);
        },

        attrchk(attr: Record<string, unknown>): void {
            const unknown = unknownAttrNames(attr);
            if (!unknown) return;
            const name = unknown.split(', ')[0]!;
            throw unsupportedAttribute(name, attr[name]);
        },
    });

    function parentLocal(parent: string): string {
        try { return resolver.getInfo(parent).localPath; }
        catch { return parent; }
    }

    function moduleKey(info: ModuleInfo): string {
        return `${moduleRef(info)}\0${info.fileKind}\0${info.format}`;
    }

    return {
        clearLoadedModules() { loadedModules.clear(); },
    };
}
