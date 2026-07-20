import { dirname, joinPaths, ensureDir, log, canonicalizePath, normalizePath } from '../utils';
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

const FRESHNESS_VERSION = 'jsc-v2';

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
    private readonly localDir: string | null;
    private readonly cacheRoot: string | null;

    constructor(cacheDir?: string) {
        this.localDir = cacheDir ? joinPaths(cacheDir, 'local') : null;
        this.cacheRoot = cacheDir ? canonicalizePath(normalizePath(cacheDir)) : null;
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
        return target === root || target.startsWith(root + '/');
    }

    /** Select adjacent remote storage or an isolated local hashed cache. */
    private cachePaths(localPath: string, remote: boolean): { jsc: string; mt: string } | null {
        if (remote && this.isCacheOwnedPath(localPath)) return this.remoteCachePaths(localPath);
        return this.localCachePath(localPath);
    }

    private legacyFreshnessToken(localPath: string, cachedMtime?: number): string {
        const stat = fs.stat(localPath);
        return `${String(cachedMtime ?? stat.mtim)}:${stat.size}`;
    }

    /** Identity-aware sidecars reject legacy stamps instead of risking a stale graph. */
    private freshnessToken(localPath: string, cachedMtime?: number, moduleId?: string): string {
        const stamp = this.legacyFreshnessToken(localPath, cachedMtime);
        return moduleId === undefined
            ? stamp
            : `${FRESHNESS_VERSION}\n${stamp}\n${encodeURIComponent(moduleId)}`;
    }

    private isFreshMtime(localPath: string, mtPath: string, cachedMtime?: number, moduleId?: string): boolean {
        try {
            const cachedMt = engine.decodeString(fs.readFile(mtPath));
            return cachedMt === this.freshnessToken(localPath, cachedMtime, moduleId);
        } catch {
            return false;
        }
    }

    private hasFreshFile(
        paths: { jsc: string; mt: string },
        localPath: string,
        cachedMtime?: number,
        moduleId?: string,
    ): boolean {
        try {
            if (!this.isFreshMtime(localPath, paths.mt, cachedMtime, moduleId)) return false;
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

    private writeMtime(localPath: string, mtPath: string, moduleId?: string): void {
        fs.writeFile(mtPath, engine.encodeString(this.freshnessToken(localPath, undefined, moduleId)));
    }

    private writeCacheFile(
        paths: { jsc: string; mt: string },
        localPath: string,
        bytecode: ArrayBuffer,
        moduleId?: string,
    ): void {
        ensureDir(dirname(paths.jsc));
        fs.writeFile(paths.jsc, bytecode);
        this.writeMtime(localPath, paths.mt, moduleId);
    }

    load(localPath: string, remote: boolean, cachedMtime?: number, moduleId?: string): CModuleEngine.Module | null {
        return this.loadRaw(localPath, remote, cachedMtime, moduleId) as CModuleEngine.Module | null;
    }

    /** load() for non-Module values (e.g. EVAL_COMPILE_ONLY); raw deserialize. */
    loadCompiled(localPath: string, remote: boolean, cachedMtime?: number, moduleId?: string): unknown | null {
        return this.loadRaw(localPath, remote, cachedMtime, moduleId);
    }

    private loadRaw(localPath: string, remote: boolean, cachedMtime?: number, moduleId?: string): unknown | null {
        // L1a: owned buffers (precompile one-shot)
        const key = memoryKey(localPath, moduleId);
        const bc = this.memory.get(key);
        if (bc) {
            try {
                const mod = engine.deserialize(new Uint8Array(bc));
                this.memory.delete(key);
                return mod;
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
                return engine.deserialize(bytes);
            } catch {
                log.debug('jsc', () => `vfs bytecode deserialize failed: ${localPath}`);
                // Fall through: source recompile (ABI mismatch / corrupt blob).
            }
        }

        // L2: on-disk only for real filesystem paths
        if (remote) {
            const paths = this.cachePaths(localPath, remote);
            if (!paths) return null;
            if (!this.isFreshMtime(localPath, paths.mt, cachedMtime, moduleId)) {
                removeCacheFiles(paths);
                return null;
            }
            try {
                return engine.deserialize(new Uint8Array(fs.readFile(paths.jsc)));
            } catch {
                removeCacheFiles(paths);
                return null;
            }
        }

        const paths = this.cachePaths(localPath, remote);
        if (!paths) return null;

        try {
            const cachedMt = engine.decodeString(fs.readFile(paths.mt));
            if (cachedMt !== this.freshnessToken(localPath, cachedMtime, moduleId)) {
                removeCacheFiles(paths);
                return null;
            }
        } catch {
            removeCacheFiles(paths);
            return null;
        }

        try {
            return engine.deserialize(new Uint8Array(fs.readFile(paths.jsc)));
        } catch {
            log.debug('jsc', () => `disk deserialize failed: ${paths.jsc}`);
            removeCacheFiles(paths);
            return null;
        }
    }

    /** On-disk .jsc bytes only (no deserialize); for pack. Null if not durable. */
    loadRawBytes(localPath: string, remote: boolean, cachedMtime?: number, moduleId?: string): ArrayBuffer | null {
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
    hasFresh(localPath: string, remote: boolean, cachedMtime?: number, moduleId?: string): boolean {
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return false;
        return this.hasFreshFile(paths, localPath, cachedMtime, moduleId);
    }

    clearMemory(): void {
        this.memory.clear();
    }

    setMemory(localPath: string, bc: ArrayBuffer, moduleId?: string): void {
        this.memory.set(memoryKey(localPath, moduleId), bc);
    }

    persistBytecode(localPath: string, bc: ArrayBuffer, remote: boolean, moduleId?: string): void {
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc, moduleId);
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

    persist(localPath: string, mod: CModuleEngine.Module, moduleId?: string): void {
        const paths = this.cachePaths(localPath, true);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump(), moduleId);
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    persistLocal(localPath: string, mod: CModuleEngine.Module, moduleId?: string): void {
        const paths = this.cachePaths(localPath, false);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump(), moduleId);
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
