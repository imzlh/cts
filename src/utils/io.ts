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

export function resolveFile(base: string, exts = EXTS): string {
    const hit = cache.get(base);
    if (hit) return hit;
    const found = _resolve(base, exts);
    cache.set(base, found);
    if (found !== base) cache.set(found, found); // identity shortcut
    return found;
}

function tryFile(p: string): string | null {
    try {
        const st = fs.stat(p);
        if (st.isFile) return p;
        if (st.isDirectory) return resolveFile(joinPaths(p, 'index'));
    } catch {}
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
    // index.<ext>
    for (const e of exts) {
        const r = tryFile(joinPaths(base, 'index' + e));
        if (r) return r;
    }
    throw err(ErrorKind.FileNotFound, `Cannot resolve: ${base}`);
}

export function clearResolveCache(): void { cache.clear(); }
