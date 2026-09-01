import type { ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import { dirname, isAbsolute, toFileUrl, toHostPath, schemeId } from '../utils';
export { toFileUrl } from '../utils';
import {
    hasModuleResolveHooks,
    runModuleResolveHooks,
    type ModuleResolveContext,
    type ModuleResolveResult,
} from '../module-hooks';

const importMetaResolveCache = new Map<string, (s: string, p?: string, a?: Record<string, unknown>) => string>();

/** Closures capture the resolver; a new runtime must not reuse the old one's. */
export function clearImportMetaResolveCache(): void {
    importMetaResolveCache.clear();
}

/** True when spec carries its own scheme (http:, npm:, data:, file:, …).
 *  Exported for runtime/hooks.ts. */
export function isProtocolSpec(spec: string): boolean {
    return schemeId(spec) !== null;
}

export function toImportMetaUrl(info: ModuleInfo): string {
    // Protocol specs (pack:, npm:, http:, …) keep their identity as URL.
    // Avoid isAbsolute on "pack:/x" which looks absolute after the scheme.
    if (info.specPath.includes('://') || isProtocolSpec(info.specPath)) {
        if (info.specPath.startsWith('npm:') || info.specPath.startsWith('jsr:')) {
            return toFileUrl(info.localPath);
        }
        return info.specPath;
    }
    if (isAbsolute(info.specPath) || isAbsolute(info.localPath)) {
        return toFileUrl(info.localPath);
    }
    return info.specPath;
}

function moduleFormat(info: ModuleInfo): string {
    if (info.fileKind === 'json') return 'json';
    if (info.fileKind === 'wasm') return 'wasm';
    return info.format === 'cjs' ? 'commonjs' : 'module';
}

function withHookFormat(info: ModuleInfo, format: string | null | undefined): ModuleInfo {
    if (format === 'commonjs' && info.format !== 'cjs') return { ...info, format: 'cjs' };
    if (format === 'module' && info.format !== 'esm') return { ...info, format: 'esm' };
    return info;
}

function parentUrl(parent: string, resolver: ModuleResolver): string {
    try {
        return toImportMetaUrl(resolver.getInfo(parent));
    } catch {
        return isProtocolSpec(parent) ? parent : toFileUrl(parent);
    }
}

/** Resolve through node:module synchronous hooks while retaining CTS identity. */
export function resolveWithModuleHooks(
    resolver: ModuleResolver,
    specifier: string,
    parent: string,
    attributes?: Record<string, unknown>,
): ModuleInfo {
    if (!hasModuleResolveHooks()) return resolver.resolve(specifier, parent, attributes);

    const terminalResolutions: Array<{
        result: ModuleResolveResult;
        url: string;
        info: ModuleInfo;
    }> = [];
    const context: ModuleResolveContext = {
        parentURL: parentUrl(parent, resolver),
        conditions: ['node', 'import', 'node-addons'],
        importAttributes: attributes,
    };
    const result = runModuleResolveHooks(specifier, context, (nextSpecifier, nextContext) => {
        const info = resolver.resolve(
            nextSpecifier,
            nextContext.parentURL ?? parent,
            nextContext.importAttributes ?? attributes,
        );
        const url = toImportMetaUrl(info);
        const terminalResult: ModuleResolveResult = {
            url,
            format: moduleFormat(info),
            shortCircuit: true,
        };
        terminalResolutions.push({ result: terminalResult, url, info });
        return terminalResult;
    });

    // The normal nextResolve() path already produced the canonical ModuleInfo.
    // Re-resolving its file URL would collapse npm/jsr identity to a disk path.
    let terminal = terminalResolutions.find((entry) => entry.result === result && entry.url === result.url);
    if (!terminal) {
        const matching = terminalResolutions.filter((entry) => entry.url === result.url);
        if (matching.length === 1) terminal = matching[0];
    }
    if (terminal) {
        return withHookFormat(terminal.info, result.format);
    }

    const resolved = resolver.resolve(result.url, parent, attributes);
    return withHookFormat(resolved, result.format);
}

/** Fill import.meta with standard properties. */
export function fillMeta(
    meta: Record<string, unknown>,
    info: ModuleInfo,
    resolver: ModuleResolver,
): void {
    meta.url      = toImportMetaUrl(info);
    // localPath is POSIX-internal (cts/AGENT.md:230). filename/dirname are
    // user-visible, so they cross the boundary and must be NATIVE, matching
    // node v24.18.0 and deno 2.9.3 measured on Windows 11:
    //   deno: import.meta.filename -> D:\tmp\agsep\dn.ts   (not D:/tmp/...)
    //   node: import.meta.dirname  -> D:\tmp\agsep
    // meta.url stays a file:// URL with '/' — only these two denormalize.
    // toHostPath leaves scheme ids ("pack:/e.mjs") alone.
    meta.filename = toHostPath(info.localPath);
    meta.dirname  = toHostPath(dirname(info.localPath));
    meta.main     = info.specPath === resolver.entry;
    meta.use      = import.meta.use;
    meta.register = import.meta.register;
    // Pack/extensionless: keep lang for transform on source-only recompile.
    if (info.lang !== undefined && meta.lang === undefined) meta.lang = info.lang;

    // import.meta.resolve returns a URL string (Node / lib.deno.d.ts), not a host
    // path: file:// for disk modules, scheme kept for node:/http:/pack:. Same
    // mapping as meta.url so both agree. Cache per specPath.
    let fn = importMetaResolveCache.get(info.specPath);
    if (!fn) {
        const self = info.specPath;
        fn = (s: string, p?: string, a?: Record<string, unknown>) => {
            const resolved = resolveWithModuleHooks(resolver, s, p ?? self, a);
            return toImportMetaUrl(resolved);
        };
        importMetaResolveCache.set(info.specPath, fn);
    }
    meta.resolve = fn;
}
