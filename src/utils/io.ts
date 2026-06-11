// utils/io.ts — file I/O helpers with bounded LRU resolution cache

import { dirname, joinPaths } from './path';
import { LRU } from './lru';
import { fs, engine } from './index';
import { err, ErrorKind } from '../errors';

export const readText  = (p: string) => engine.decodeString(fs.readFile(p));
export const writeText = (p: string, s: string) => fs.writeFile(p, engine.encodeString(s));
export const readBytes = (p: string) => new Uint8Array(fs.readFile(p));

export function ensureDir(dir: string): void {
    if (fs.exists(dir)) return;
    const parent = dirname(dir);
    if (parent && parent !== dir && parent !== '.') ensureDir(parent);
    try {
        fs.mkdir(dir, 0o755);
    } catch {
        if (!fs.exists(dir)) throw err(ErrorKind.PermissionError, `Failed to create directory: ${dir}`);
    }
}

// ---------------------------------------------------------------------------
// resolveFile — LRU(2048) positive cache
//
// Inner loop tries each candidate with a single try/stat — no separate exists().
// Directories trigger a recursive index lookup.
// ---------------------------------------------------------------------------

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.wasm'];
const cache = new LRU<string, string>(2048);
const negCache = new Set<string>();  // paths known not to exist

export function resolveFile(base: string, exts = EXTS): string {
    const hit = cache.get(base);
    if (hit) return hit;
    if (negCache.has(base)) throw err(ErrorKind.FileNotFound, `Cannot resolve: ${base}`);
    const found = _resolve(base, exts);
    cache.set(base, found);
    if (found !== base) cache.set(found, found); // identity shortcut
    return found;
}

/** Mark a path as definitively non-existent (stat failed). */
function markMissing(p: string): void { negCache.add(p); }

/** Clear negative cache to allow re-checking paths */
export function clearNegativeCache(): void { negCache.clear(); }

function tryFile(p: string): string | null {
    if (negCache.has(p)) return null;
    try {
        const st = fs.stat(p);
        if (st.isFile) return p;
        if (st.isDirectory) {
            // For directory index lookup, always use full EXTS (not caller's exts)
            const idx = tryIndex(joinPaths(p, 'index'), EXTS);
            if (idx) return idx;
        }
    } catch {
        markMissing(p);
    }
    return null;
}

function tryIndex(base: string, exts: string[]): string | null {
    for (const e of exts) {
        const p = base + e;
        if (negCache.has(p)) continue;
        try {
            if (fs.stat(p).isFile) return p;
        } catch { markMissing(p); }
    }
    return null;
}

function _resolve(base: string, exts: string[]): string {
    // Exact path / directory
    const exact = tryFile(base);
    if (exact) return exact;
    // With extension
    for (const e of exts) {
        const r = tryFile(base + e);
        if (r) return r;
    }
    // index.<ext> — always use full extension list for index files
    const idx = tryIndex(joinPaths(base, 'index'), EXTS);
    if (idx) return idx;
    markMissing(base);
    throw err(ErrorKind.FileNotFound, `Cannot resolve: ${base}`);
}

export function clearResolveCache(): void { cache.clear(); negCache.clear(); }
