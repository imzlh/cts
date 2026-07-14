import { dirname, isAbsolute, joinPaths } from './path';
import { LRU } from './lru';
import { err, ErrorKind } from '../errors';
import { getMemoryFile } from './memfs';
import { isWindows } from './platform';
import { yieldEventLoop } from './yield';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

export const readText = (p: string) => {
    const v = getMemoryFile(p);
    // undefined only — empty Uint8Array is a valid VFS hit.
    if (v !== undefined) return engine.decodeString(v);
    return engine.decodeString(fs.readFile(p));
};
export const writeText = (p: string, s: string) => fs.writeFile(p, engine.encodeString(s));
/** Prefer active VFS view (0-copy subarray); else fs. */
export const readBytes = (p: string) => {
    const v = getMemoryFile(p);
    if (v !== undefined) return v;
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

// hardlinkOrCopyDirRecursive — hard mode: hardlink files, copy on EXDEV; keep symlinks.
// Yields the event loop during huge trees so other timers can run (not a UI API).

/** Sync walk — only for tiny trees / tests; prefer async for materialize. */
export function hardlinkOrCopyDirRecursiveSync(src: string, dest: string): void {
    ensureDir(dest);
    for (const entry of fs.readdir(src, true)) {
        const s = joinPaths(src, entry.name);
        const d = joinPaths(dest, entry.name);
        if (entry.isSymbolicLink) {
            linkSymlinkEntry(s, d);
        } else if (entry.isDirectory) {
            hardlinkOrCopyDirRecursiveSync(s, d);
        } else {
            hardlinkOrCopyFile(s, d);
        }
    }
}

export interface HardlinkWalkOptions {
    /** Top-level entry names to skip (e.g. store-owned `node_modules`). */
    skipNames?: readonly string[];
    /** Yield after this many file ops (default 256; was 64). */
    yieldEvery?: number;
    /** Min ms between yields (default 50; was 16). */
    yieldMs?: number;
}

/** Cooperative hard materialize walk; yields every ~256 files or ~50ms by default. */
export async function hardlinkOrCopyDirRecursive(
    src: string,
    dest: string,
    opts?: HardlinkWalkOptions,
): Promise<void> {
    const skip = opts?.skipNames?.length ? new Set(opts.skipNames) : null;
    const yieldEvery = opts?.yieldEvery ?? 256;
    const yieldMs = opts?.yieldMs ?? 50;
    let ops = 0;
    let lastYieldMs = Date.now();
    const maybeYield = async (): Promise<void> => {
        ops++;
        const now = Date.now();
        if (ops < yieldEvery && now - lastYieldMs < yieldMs) return;
        ops = 0;
        lastYieldMs = now;
        await yieldEventLoop();
    };

    const walk = async (from: string, to: string, top: boolean): Promise<void> => {
        ensureDir(to);
        for (const entry of fs.readdir(from, true)) {
            if (top && skip?.has(entry.name)) continue;
            const s = joinPaths(from, entry.name);
            const d = joinPaths(to, entry.name);
            if (entry.isSymbolicLink) {
                linkSymlinkEntry(s, d);
                await maybeYield();
            } else if (entry.isDirectory) {
                await walk(s, d, false);
            } else {
                hardlinkOrCopyFile(s, d);
                await maybeYield();
            }
        }
    };
    await walk(src, dest, true);
}

function linkSymlinkEntry(s: string, d: string): void {
    // Relative install links (../pkg@ver) break when re-rooted under hard views.
    let target = fs.readlink(s);
    if (!isAbsolute(target)) {
        try {
            target = fs.realpath(s);
        } catch {
            // Dangling relative: keep as-is.
        }
    }
    unlinkIfExists(d);
    if (isWindows) {
        let kind: 'file' | 'dir' = 'file';
        try {
            if (fs.stat(s).isDirectory) kind = 'dir';
        } catch {}
        fs.symlink(target, d, kind);
    } else {
        fs.symlink(target, d);
    }
}

function hardlinkOrCopyFile(s: string, d: string): void {
    unlinkIfExists(d);
    try {
        fs.link(s, d);
    } catch {
        fs.copy(s, d);
    }
}
