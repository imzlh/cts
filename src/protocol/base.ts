// protocol/base.ts — ProtocolHandler interface
//
// Design principle:
//   resolve()   → downloads/copies to cache, returns complete ModuleInfo
//   localPath() → fast lookup for already-resolved specPaths (no I/O needed)
//
// The resolver.ts orchestrator calls resolve() once per specifier, caches the
// returned ModuleInfo by specPath, then calls localPath() on subsequent load
// requests.  Protocol handlers don't need to worry about the runtime cache.

import type { ModuleInfo, FileKind } from '../types';
import { extname } from '../utils';

export type { ModuleInfo };

export interface ProtocolHandler {
    /** List of protocol prefixes this handler owns, e.g. ['http', 'https']. */
    readonly protocols: string[];

    /**
     * Fully resolve a specifier to a ModuleInfo.
     * Downloads remote content to the cache if necessary.
     */
    resolve(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo;

    /**
     * Return the local file path for a canonical specPath.
     * Called during the load phase; the specPath was produced by resolve().
     * Must be fast (no network I/O).
     */
    localPath(specPath: string): string;
}

// ---------------------------------------------------------------------------
// Helpers shared by all protocol handlers
// ---------------------------------------------------------------------------

const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc']); 

export function guessFileKind(localPath: string): FileKind {
    const ext = extname(localPath);
    if (!ext)                                 return 'binary';
    if (ext === '.wasm')                      return 'wasm';
    if (ext === '.json' || ext === '.jsonc')  return 'json';
    if (TEXT_EXTS.has(ext))                   return 'source';
    return 'binary';
}

/** Check if a path is a TypeScript type declaration file (.d.ts, .d.mts, .d.cts) */
export function isTypeDecl(localPath: string): boolean {
    return localPath.endsWith('.d.ts') || localPath.endsWith('.d.mts') || localPath.endsWith('.d.cts');
}
