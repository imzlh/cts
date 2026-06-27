// runtime/meta.ts — import.meta population
//
// Fills import.meta with url, filename, dirname, main, use, resolve
// for each loaded module.

import type { ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import { dirname, isAbsolute } from '../utils/path';

const importMetaResolveCache = new Map<string, (s: string, p?: string, a?: Record<string, any>) => string>();

function toFileUrl(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
    if (normalized.startsWith('//')) return `file:${normalized}`;
    return normalized.startsWith('/') ? `file://${normalized}` : normalized;
}

function toImportMetaUrl(info: ModuleInfo): string {
    if (isAbsolute(info.specPath) || isAbsolute(info.localPath)) {
        return toFileUrl(info.localPath);
    }
    if (info.specPath.includes('://') || /^[a-z][a-z0-9.+-]*:/i.test(info.specPath)) {
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
    meta: Record<string, any>,
    info: ModuleInfo,
    resolver: ModuleResolver,
): void {
    meta.url      = toImportMetaUrl(info);
    meta.filename = info.localPath;
    meta.dirname  = dirname(info.localPath);
    meta.main     = info.specPath === resolver.entry;
    meta.use      = import.meta.use;

    // import.meta.resolve — reuse cached closure per specPath.
    // Returns localPath (usable as file path), not specPath (which may be
    // a protocol specifier like npm:vite@8.1.0/... that is not a valid file path).
    let fn = importMetaResolveCache.get(info.specPath);
    if (!fn) {
        const self = info.specPath;
        fn = (s: string, p?: string, a?: Record<string, any>) => {
            const resolved = resolver.resolve(s, p ?? self, a);
            return resolved.localPath;
        };
        importMetaResolveCache.set(info.specPath, fn);
    }
    meta.resolve = fn;
}
