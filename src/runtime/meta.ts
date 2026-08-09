import type { ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import { dirname, isAbsolute, toHostPath, toPosixPath } from '../utils';

const importMetaResolveCache = new Map<string, (s: string, p?: string, a?: Record<string, unknown>) => string>();

/** Closures capture the resolver; a new runtime must not reuse the old one's. */
export function clearImportMetaResolveCache(): void {
    importMetaResolveCache.clear();
}

// Encode # etc. in file URLs (es5-ext uses a real "#" directory).
function encodeFileUrlPath(path: string): string {
    let out = '';
    for (let i = 0; i < path.length; i++) {
        const c = path.charCodeAt(i);
        if (c === 35 /*#*/ || c === 63 /*?*/ || c === 37 /*%*/ || c === 32 /* */) {
            out += `%${c.toString(16).toUpperCase().padStart(2, '0')}`;
        } else {
            out += path[i];
        }
    }
    return out;
}

/** Path → file: URL. Exported for runtime/hooks.ts, which needs the same
 *  encoding to build the `url` property node puts on ERR_MODULE_NOT_FOUND. */
export function toFileUrl(path: string): string {
    const normalized = toPosixPath(path);
    if (isWindowsDrivePath(normalized)) return `file:///${encodeFileUrlPath(normalized)}`;
    if (normalized.startsWith('//')) return `file:${encodeFileUrlPath(normalized)}`;
    return normalized.startsWith('/') ? `file://${encodeFileUrlPath(normalized)}` : normalized;
}

function isAsciiAlpha(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** True when spec carries its own scheme (http:, npm:, data:, file:, …).
 *  Exported for runtime/hooks.ts. */
export function isProtocolSpec(spec: string): boolean {
    // Windows drive paths (C:/x) look like a single-letter scheme — not protocol specs.
    if (isWindowsDrivePath(toPosixPath(spec))) return false;
    if (!isAsciiAlpha(spec.charCodeAt(0))) return false;
    for (let i = 1; i < spec.length; i++) {
        const c = spec.charCodeAt(i);
        // Require >= 2 chars before the ':' so single-letter (drive) schemes don't match.
        if (c === 58) return i >= 2;
        if (isAsciiAlpha(c) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
        return false;
    }
    return false;
}

function isWindowsDrivePath(path: string): boolean {
    return path.length >= 3 && isAsciiAlpha(path.charCodeAt(0)) && path.charCodeAt(1) === 58 && path.charCodeAt(2) === 47;
}

function toImportMetaUrl(info: ModuleInfo): string {
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
            const resolved = resolver.resolve(s, p ?? self, a);
            return toImportMetaUrl(resolved);
        };
        importMetaResolveCache.set(info.specPath, fn);
    }
    meta.resolve = fn;
}
