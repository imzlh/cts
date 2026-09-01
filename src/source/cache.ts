import { dirname, joinPaths, ensureDir, log, canonicalizePath, normalizePath, isPathWithin } from '../utils';
import { getMemoryBytecode, hasActiveFileStore, hasMemoryFile } from '../utils/memfs';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

function unlinkIfExists(path: string): void {
    try {
        fs.unlink(path);
    } catch {}
}

function removeCacheFiles(paths: { jsc: string; mt: string }): void {
    unlinkIfExists(paths.jsc);
    unlinkIfExists(paths.mt);
}

const FRESHNESS_VERSION = 'jsc-v3';

export interface SourceFreshness {
    mtim: string;
    size: number;
    /** md5 of the exact source bytes the stamp describes (see sourceDigest). */
    hash: string;
}

/**
 * The bytes and freshness token observed for one source revision.
 *
 * A cache lookup already has to read and hash the source in order to validate
 * a v3 sidecar. Keeping that read alongside the token lets the compiler reuse
 * it on a miss instead of opening and hashing the same file again.
 */
export interface SourceSnapshot {
    bytes: Uint8Array;
    freshness: SourceFreshness;
}

/**
 * Full-precision mtime token.
 *
 * `String(date)` renders only whole seconds ("Sun Aug 02 2026 11:16:59 GMT+0800"),
 * so a same-size edit landing in the same wall-clock second produced a stamp
 * identical to the previous revision and stale bytecode was served. Epoch
 * milliseconds keep every bit fs.stat reports. Plain numbers (resolver-supplied
 * mtimes for remote entries) pass through unchanged.
 */
function mtimeToken(mtim: unknown): string {
    const t = (mtim as Date | undefined)?.getTime?.();
    return typeof t === 'number' && t === t ? String(t) : String(mtim);
}

/**
 * md5 of the source bytes. mtime+size alone cannot detect a same-size edit that
 * keeps (or restores, e.g. `touch -r`, `git checkout`, codegen) the mtime, so the
 * content itself is the authority. Cheap: one small read plus a hash, only on the
 * freshness check, versus a full transform+compile on a miss.
 */
function sourceDigest(bytes: CModuleCrypto.BufferSource): string {
    return crypto.hexEncode(crypto.md5(bytes));
}

/** Deserialized value is valid but the wrong shape for this caller (see loadRaw). */
const MISMATCH = Symbol('cts.jsc.shapeMismatch');

function memoryKey(localPath: string, moduleId?: string): string {
    return `${localPath}\0${moduleId ?? ''}`;
}

export function isRemote(specPath: string): boolean {
    return specPath.startsWith('http://') || specPath.startsWith('https://')
        || specPath.startsWith('jsr:') || specPath.startsWith('npm:')
        || specPath.startsWith('node:') || specPath.startsWith('pack:')
        || specPath.startsWith('ctsview:');
}

/** True only for real FS paths (not pack:/ctsview:). */
export function isFileBackedPath(localPath: string): boolean {
    if (localPath.startsWith('pack:') || localPath.startsWith('ctsview:')) return false;
    // Skip VFS has() when no overlay is installed (common disk-only runs).
    if (hasActiveFileStore() && hasMemoryFile(localPath)) return false;
    return true;
}

export class JscCache {
    /** Optional owned L1 buffers (precompile); pack uses VFS bytecode() instead. */
    private readonly memory = new Map<string, ArrayBuffer>();
    /** Source bytes observed by a disk-cache miss; consumed by the compiler. */
    private readonly sourceSnapshots = new Map<string, SourceSnapshot>();
    private readonly localDir: string | null;
    private readonly cacheRoot: string | null;

    constructor(cacheDir?: string) {
        this.cacheRoot = cacheDir ? canonicalizePath(normalizePath(cacheDir)) : null;
        this.localDir = this.cacheRoot ? joinPaths(this.cacheRoot, 'local') : null;
    }

    // Local cache path: {cacheDir}/local/{hash[0:2]}/{hash}.jsc

    private localCachePath(localPath: string): { jsc: string; mt: string } | null {
        if (!this.localDir || !isFileBackedPath(localPath)) return null;
        const hash = crypto.hexEncode(crypto.md5(engine.encodeString(localPath)));
        const dir = joinPaths(this.localDir, hash.slice(0, 2));
        const base = joinPaths(dir, hash);
        return { jsc: base + '.jsc', mt: base + '.jsc.mt' };
    }

    // Load: L1 (memory) → L2 (disk .jsc) → null

    private remoteCachePaths(localPath: string): { jsc: string; mt: string } | null {
        if (!isFileBackedPath(localPath)) return null;
        const jsc = localPath + '.jsc';
        return { jsc, mt: jsc + '.mt' };
    }

    /** Keep adjacent remote bytecode inside the configured cache root. */
    private isCacheOwnedPath(localPath: string): boolean {
        // Direct JscCache consumers without a root historically used adjacent
        // remote files; retain that behavior for backwards compatibility.
        if (!this.cacheRoot) return true;
        let root = this.cacheRoot;
        let target = canonicalizePath(normalizePath(localPath));
        try { root = canonicalizePath(normalizePath(fs.realpath(root))); } catch {}
        try { target = canonicalizePath(normalizePath(fs.realpath(localPath))); } catch {}
        return isPathWithin(root, target);
    }

    /** Select adjacent remote storage or an isolated local hashed cache. */
    private cachePaths(localPath: string, remote: boolean): { jsc: string; mt: string } | null {
        if (remote && this.isCacheOwnedPath(localPath)) return this.remoteCachePaths(localPath);
        return this.localCachePath(localPath);
    }

    /** Take the source read performed by the preceding cache lookup. */
    takeSourceSnapshot(localPath: string, moduleId?: string): SourceSnapshot | undefined {
        const key = memoryKey(localPath, moduleId);
        const snapshot = this.sourceSnapshots.get(key);
        this.sourceSnapshots.delete(key);
        return snapshot;
    }

    /** Read source bytes once and derive the matching freshness token. */
    readSource(localPath: string): SourceSnapshot | undefined {
        try {
            const stat = fs.stat(localPath);
            const bytes = new Uint8Array(fs.readFile(localPath));
            // size comes from the hashed bytes so both fields describe one revision.
            const freshness = { mtim: mtimeToken(stat.mtim), size: bytes.byteLength, hash: sourceDigest(bytes) };
            return { bytes, freshness };
        } catch {
            return undefined;
        }
    }

    captureFreshness(localPath: string): SourceFreshness | undefined {
        return this.readSource(localPath)?.freshness;
    }

    private legacyFreshnessToken(localPath: string, cachedMtime?: number, source?: SourceFreshness): string {
        if (source) {
            // Resolver-supplied mtimes deliberately override the filesystem
            // mtime while retaining the source bytes/hash from the snapshot.
            const mtim = cachedMtime === undefined ? source.mtim : mtimeToken(cachedMtime);
            return `${mtim}:${source.size}:${source.hash}`;
        }
        const stat = fs.stat(localPath);
        const bytes = new Uint8Array(fs.readFile(localPath));
        return `${mtimeToken(cachedMtime ?? stat.mtim)}:${bytes.byteLength}:${sourceDigest(bytes)}`;
    }

    /**
     * Identity-aware sidecars reject legacy stamps instead of risking a stale graph.
     * The version prefix is unconditional: a v2 stamp (second-granularity mtime, no
     * content hash) must never satisfy a v3 check, so pre-upgrade entries recompile
     * once rather than being trusted.
     */
    private freshnessToken(localPath: string, cachedMtime?: number, moduleId?: string, source?: SourceFreshness): string {
        const stamp = this.legacyFreshnessToken(localPath, cachedMtime, source);
        return moduleId === undefined
            ? `${FRESHNESS_VERSION}\n${stamp}`
            : `${FRESHNESS_VERSION}\n${stamp}\n${encodeURIComponent(moduleId)}`;
    }

    private isFreshMtime(
        localPath: string,
        mtPath: string,
        cachedMtime?: number,
        moduleId?: string,
        source?: SourceFreshness,
    ): boolean {
        try {
            const cachedMt = engine.decodeString(fs.readFile(mtPath));
            return cachedMt === this.freshnessToken(localPath, cachedMtime, moduleId, source);
        } catch {
            return false;
        }
    }

    private hasFreshFile(
        paths: { jsc: string; mt: string },
        localPath: string,
        cachedMtime?: number,
        moduleId?: string,
        source?: SourceFreshness,
    ): boolean {
        try {
            if (!this.isFreshMtime(localPath, paths.mt, cachedMtime, moduleId, source)) return false;
            return !!fs.stat(paths.jsc);
        } catch {
            return false;
        }
    }

    private removeLocalCacheDir(dir: string): void {
        try {
            if (!fs.stat(dir).isDirectory) return;
            for (const f of fs.readdir(dir)) {
                unlinkIfExists(joinPaths(dir, f));
            }
            try {
                fs.rmdir(dir);
            } catch {
                // Another process may have touched this cache shard.
            }
        } catch {
            // Ignore unreadable shards while clearing best-effort local cache.
        }
    }

    private writeMtime(localPath: string, mtPath: string, moduleId?: string, source?: SourceFreshness): void {
        fs.writeFile(mtPath, engine.encodeString(this.freshnessToken(localPath, undefined, moduleId, source)));
    }

    private writeCacheFile(
        paths: { jsc: string; mt: string },
        localPath: string,
        bytecode: ArrayBuffer,
        moduleId?: string,
        source?: SourceFreshness,
    ): void {
        ensureDir(dirname(paths.jsc));
        fs.writeFile(paths.jsc, bytecode);
        this.writeMtime(localPath, paths.mt, moduleId, source);
    }

    load(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): CModuleEngine.Module | null {
        return this.loadRaw(localPath, remote, cachedMtime, moduleId, true) as CModuleEngine.Module | null;
    }

    /** load() for non-Module values (e.g. EVAL_COMPILE_ONLY); raw deserialize. */
    loadCompiled(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): unknown | null {
        return this.loadRaw(localPath, remote, cachedMtime, moduleId, false);
    }

    private loadRaw(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
        wantModule = true,
    ): unknown | null {
        // CJS-wrapper and ESM bytecode share one identity for a file loaded both
        // ways (--require of an ESM-format .js); a shape mismatch is a cache miss.
        // MISMATCH keeps the entry (it is valid for the other consumer); only a
        // failed deserialize (corrupt / ABI change) clears the files.
        const accept = (value: unknown): unknown =>
            (value instanceof engine.Module) === wantModule ? value : MISMATCH;

        // L1a: owned buffers (precompile one-shot)
        const key = memoryKey(localPath, moduleId);
        // Do not let an unconsumed miss from an earlier lookup survive a retry
        // or an L1 hit for the same identity.
        this.sourceSnapshots.delete(key);
        const bc = this.memory.get(key);
        if (bc) {
            try {
                const mod = accept(engine.deserialize(new Uint8Array(bc)));
                this.memory.delete(key);
                if (mod !== MISMATCH) return mod;
            } catch {
                log.debug('jsc', () => `memory deserialize failed: ${localPath}`);
                this.memory.delete(key);
            }
        }

        // L1b: active VFS bytecode() — 0-copy view, deserialize on demand.
        // engine.deserialize is typed as ArrayBuffer-backed (not SharedArrayBuffer);
        // pack/VFS views are subarrays of that kind — re-wrap without copying when possible.
        const view = getMemoryBytecode(localPath);
        if (view) {
            try {
                const buf = view.buffer;
                const bytes = buf instanceof ArrayBuffer
                    ? new Uint8Array(buf, view.byteOffset, view.byteLength)
                    : new Uint8Array(view);
                const mod = accept(engine.deserialize(bytes));
                if (mod !== MISMATCH) return mod;
            } catch {
                log.debug('jsc', () => `vfs bytecode deserialize failed: ${localPath}`);
                // Fall through: source recompile (ABI mismatch / corrupt blob).
            }
        }

        // L2: on-disk only for real filesystem paths. A v3 freshness check
        // necessarily reads and hashes source bytes; retain that exact snapshot
        // so a miss can transform it without another stat/read/hash sequence.
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return null;
        const source = isFileBackedPath(localPath) ? this.readSource(localPath) : undefined;
        const rememberSource = () => {
            if (source) this.sourceSnapshots.set(key, source);
        };

        if (remote) {
            if (!this.isFreshMtime(localPath, paths.mt, cachedMtime, moduleId, source?.freshness)) {
                rememberSource();
                removeCacheFiles(paths);
                return null;
            }
            try {
                const mod = accept(engine.deserialize(new Uint8Array(fs.readFile(paths.jsc))));
                if (mod !== MISMATCH) {
                    return mod;
                }
                rememberSource();
                return null;
            } catch {}
            rememberSource();
            removeCacheFiles(paths);
            return null;
        }

        try {
            const cachedMt = engine.decodeString(fs.readFile(paths.mt));
            if (cachedMt !== this.freshnessToken(localPath, cachedMtime, moduleId, source?.freshness)) {
                rememberSource();
                removeCacheFiles(paths);
                return null;
            }
        } catch {
            rememberSource();
            removeCacheFiles(paths);
            return null;
        }

        try {
            const mod = accept(engine.deserialize(new Uint8Array(fs.readFile(paths.jsc))));
            if (mod !== MISMATCH) {
                return mod;
            }
            rememberSource();
            return null;
        } catch {
            log.debug('jsc', () => `disk deserialize failed: ${paths.jsc}`);
        }
        rememberSource();
        removeCacheFiles(paths);
        return null;
    }

    /** On-disk .jsc bytes only (no deserialize); for pack. Null if not durable. */
    loadRawBytes(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): ArrayBuffer | null {
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return null;
        if (!this.hasFreshFile(paths, localPath, cachedMtime, moduleId)) return null;
        try {
            return fs.readFile(paths.jsc);
        } catch {
            return null;
        }
    }

    /** Freshness without deserializing (precache gate). */
    hasFresh(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): boolean {
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return false;
        return this.hasFreshFile(paths, localPath, cachedMtime, moduleId);
    }

    clearMemory(): void {
        this.memory.clear();
        this.sourceSnapshots.clear();
    }

    setMemory(localPath: string, bc: ArrayBuffer, moduleId?: string): void {
        this.memory.set(memoryKey(localPath, moduleId), bc);
    }

    persistBytecode(localPath: string, bc: ArrayBuffer, remote: boolean, moduleId?: string, source?: SourceFreshness): void {
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc, moduleId, source);
        } catch (e) { log.warn('jsc', `persistBytecode failed: ${paths.jsc}`, e); }
    }

    persistMemory(localPath: string, moduleId?: string): void {
        const bc = this.memory.get(memoryKey(localPath, moduleId));
        if (!bc) return;
        const paths = this.cachePaths(localPath, true);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc, moduleId);
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    persist(localPath: string, mod: CModuleEngine.Module, moduleId?: string, source?: SourceFreshness): void {
        const paths = this.cachePaths(localPath, true);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump(), moduleId, source);
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    persistLocal(localPath: string, mod: CModuleEngine.Module, moduleId?: string, source?: SourceFreshness): void {
        const paths = this.cachePaths(localPath, false);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump(), moduleId, source);
            log.debug('jsc', () => `cached local: ${localPath}`);
        } catch (e) {
            log.warn('jsc', `persistLocal failed: ${paths.jsc}`, e);
        }
    }

    clearLocal(): void {
        if (!this.localDir || !fs.exists(this.localDir)) return;
        try {
            for (const entry of fs.readdir(this.localDir)) {
                const p = joinPaths(this.localDir, entry);
                this.removeLocalCacheDir(p);
            }
            log.debug('jsc', () => `cleared local cache: ${this.localDir}`);
        } catch (e) {
            log.debug('jsc', () => `clearLocal failed: ${e}`);
        }
    }
}
