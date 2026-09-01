import { dirname, isAbsolute, joinPaths } from './path';
import { LRU } from './lru';
import { err, ErrorKind } from '../errors';
import { getMemoryFile } from './memfs';
import { isWindows } from './platform';
import { yieldEventLoop } from './yield';

const fs = import.meta.use('fs');
const asyncfs = import.meta.use('asyncfs');
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

/** Existence probes used by filesystem orchestration; false covers any fs error. */
export function pathExistsSync(path: string): boolean {
    try {
        fs.stat(path);
        return true;
    } catch {
        return false;
    }
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await asyncfs.stat(path);
        return true;
    } catch {
        return false;
    }
}

function isDirectorySync(path: string): boolean {
    try {
        return fs.stat(path).isDirectory;
    } catch {
        return false;
    }
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await asyncfs.stat(path)).isDirectory;
    } catch {
        return false;
    }
}

function unlinkIfExists(path: string): void {
    try {
        fs.unlink(path);
    } catch {}
}

export function ensureDir(dir: string): void {
    if (isDirectorySync(dir)) return;
    const parent = dirname(dir);
    if (parent && parent !== dir && parent !== '.') ensureDir(parent);
    try {
        fs.mkdir(dir, 0o755);
    } catch {
        // A concurrent creator may have won the race. A same-named file must
        // remain an error; `fs.exists()` cannot distinguish the two.
        if (!isDirectorySync(dir)) throw err(ErrorKind.PermissionError, `Failed to create directory: ${dir}`);
    }
}

/** Async counterpart used by flow steps and materialization callers. */
export async function ensureDirAsync(dir: string): Promise<void> {
    if (await isDirectory(dir)) return;
    const parent = dirname(dir);
    if (parent && parent !== dir && parent !== '.') await ensureDirAsync(parent);
    try {
        await asyncfs.mkdir(dir, 0o755);
    } catch {
        // A concurrent creator may have won the race. A same-named file must
        // remain an error; stat gives us the required type distinction.
        if (!await isDirectory(dir)) throw err(ErrorKind.PermissionError, `Failed to create directory: ${dir}`);
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

/** Single stat, classified. Directories are never added to negCache. */
function statKind(p: string): 'file' | 'dir' | 'missing' {
    if (negCache.has(p)) return 'missing';
    try {
        const st = fs.stat(p);
        if (st.isFile) return 'file';
        if (st.isDirectory) return 'dir';
        return 'missing';
    } catch {
        markMissing(p);
        return 'missing';
    }
}

function _resolve(base: string, exts: string[]): string {
    // Node LOAD_AS_FILE runs to completion before LOAD_AS_DIRECTORY, so a real
    // file must beat a same-named directory's index: with both `x.js` and
    // `x/index.js` on disk, `require('./x')` is `x.js`. Probing the directory
    // first (the previous behaviour) silently returned the wrong module.
    const dirCandidates: string[] = [];
    const baseKind = statKind(base);
    if (baseKind === 'file') return base;
    if (baseKind === 'dir') dirCandidates.push(base);
    for (const e of exts) {
        const p = base + e;
        const kind = statKind(p);
        if (kind === 'file') return p;
        if (kind === 'dir') dirCandidates.push(p);
    }
    // Node LOAD_AS_DIRECTORY: index.<ext> (always the full extension list).
    for (const dir of dirCandidates) {
        const idx = tryIndex(joinPaths(dir, 'index'), EXTS);
        if (idx) return idx;
    }
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
