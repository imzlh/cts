import type { ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import { dirname, isAbsolute, toPosixPath } from '../utils';

const importMetaResolveCache = new Map<string, (s: string, p?: string, a?: Record<string, unknown>) => string>();

function toFileUrl(path: string): string {
    const normalized = toPosixPath(path);
    if (isWindowsDrivePath(normalized)) return `file:///${normalized}`;
    if (normalized.startsWith('//')) return `file:${normalized}`;
    return normalized.startsWith('/') ? `file://${normalized}` : normalized;
}

function isAsciiAlpha(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isProtocolSpec(spec: string): boolean {
    if (!isAsciiAlpha(spec.charCodeAt(0))) return false;
    for (let i = 1; i < spec.length; i++) {
        const c = spec.charCodeAt(i);
        if (c === 58) return true;
        if (isAsciiAlpha(c) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
        return false;
    }
    return false;
}

function isWindowsDrivePath(path: string): boolean {
    return path.length >= 3 && isAsciiAlpha(path.charCodeAt(0)) && path.charCodeAt(1) === 58 && path.charCodeAt(2) === 47;
}

function toImportMetaUrl(info: ModuleInfo): string {
    if (isAbsolute(info.specPath) || isAbsolute(info.localPath)) {
        return toFileUrl(info.localPath);
    }
    if (info.specPath.includes('://') || isProtocolSpec(info.specPath)) {
        if (info.specPath.startsWith('npm:') || info.specPath.startsWith('jsr:')) {
            return toFileUrl(info.localPath);
        }
        return info.specPath;
    }
    return info.specPath;
}

/**
 * Fill an import.meta object with standard properties.
 */
export function fillMeta(
    meta: Record<string, unknown>,
    info: ModuleInfo,
    resolver: ModuleResolver,
): void {
    meta.url      = toImportMetaUrl(info);
    meta.filename = info.localPath;
    meta.dirname  = dirname(info.localPath);
    meta.main     = info.specPath === resolver.entry;
    meta.use      = import.meta.use;
    meta.register = import.meta.register;

    // import.meta.resolve — reuse cached closure per specPath.
    // Returns localPath (usable as file path), not specPath (which may be
    // a protocol specifier like npm:vite@8.1.0/... that is not a valid file path).
    let fn = importMetaResolveCache.get(info.specPath);
    if (!fn) {
        const self = info.specPath;
        fn = (s: string, p?: string, a?: Record<string, unknown>) => {
            const resolved = resolver.resolve(s, p ?? self, a);
            return resolved.localPath;
        };
        importMetaResolveCache.set(info.specPath, fn);
    }
    meta.resolve = fn;
}
