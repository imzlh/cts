import type { ModuleInfo, FileKind } from '../../types';
import type { Flow, ProgressCallback } from '../../flow';
import { extname } from '../../utils/path';

export type { ModuleInfo };

export interface ProtocolHandler {
    readonly protocols: string[];
    resolve(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Flow<ModuleInfo>;
    localPath(specPath: string): string;
    /** Full ModuleInfo when localPath alone cannot recover format/kind/flags (pack views). */
    getModuleInfo?(specPath: string): ModuleInfo | null;
    clearCache?(): void;
}

// ---------------------------------------------------------------------------
// Helpers shared by all protocol handlers
// ---------------------------------------------------------------------------

const TEXT_EXTS = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc']);

export function guessFileKind(localPath: string): FileKind {
    const ext = extname(localPath);
    if (!ext)                                 return 'binary';
    if (ext === '.wasm')                      return 'wasm';
    if (ext === '.json' || ext === '.jsonc')  return 'json';
    if (TEXT_EXTS.has(ext))                   return 'source';
    return 'binary';
}

/**
 * Override fileKind based on import attribute `type`.
 * Supports `import ... with { type: 'text' | 'bytes' | 'json' }`.
 */
export function applyAttrType(kind: FileKind, attr?: Record<string, unknown>): FileKind {
    const t = attr?.type;
    if (t === 'text') return 'text';
    if (t === 'bytes') return 'binary';
    if (t === 'json') return 'json';
    return kind;
}

/** Check if a path is a TypeScript type declaration file (.d.ts, .d.mts, .d.cts) */
export function isTypeDecl(localPath: string): boolean {
    return localPath.endsWith('.d.ts') || localPath.endsWith('.d.mts') || localPath.endsWith('.d.cts');
}
