import { dirname, joinPaths } from './path';
import { LRU } from './lru';
import { err, ErrorKind } from '../errors';
import { getMemoryFile } from './memfs';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

export const readText = (p: string) => {
    const v = getMemoryFile(p);
    if (v) return engine.decodeString(v);
    return engine.decodeString(fs.readFile(p));
};
export const writeText = (p: string, s: string) => fs.writeFile(p, engine.encodeString(s));
/** Prefer active VFS view (0-copy subarray); else fs. */
export const readBytes = (p: string) => {
    const v = getMemoryFile(p);
    if (v) return v;
    return new Uint8Array(fs.readFile(p));
};

function unlinkIfExists(path: string): void {
    try {
        fs.unlink(path);
    } catch {}
}

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

// resolveFile — LRU(2048); try/stat candidates; dirs recurse index.

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.node', '.wasm'];
const cache = new LRU<string, string>(2048);
const negCache = new LRU<string, boolean>(4096);  // bounded: paths known not to exist

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
function markMissing(p: string): void { negCache.set(p, true); }

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

// hardlinkOrCopyDirRecursiveSync — hard mode: hardlink files, copy on EXDEV; keep symlinks.

export function hardlinkOrCopyDirRecursiveSync(src: string, dest: string): void {
    ensureDir(dest);
    for (const entry of fs.readdir(src, true)) {
        const s = joinPaths(src, entry.name);
        const d = joinPaths(dest, entry.name);
        if (entry.isSymbolicLink) {
            const target = fs.readlink(s);
            unlinkIfExists(d);
            fs.symlink(target, d);
        } else if (entry.isDirectory) {
            hardlinkOrCopyDirRecursiveSync(s, d);
        } else {
            unlinkIfExists(d);
            try {
                fs.link(s, d);
            } catch {
                fs.copy(s, d);
            }
        }
    }
}
