import { dirname, joinPaths, ensureDir, log } from '../utils';
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

    constructor(cacheDir?: string) {
        this.localDir = cacheDir ? joinPaths(cacheDir, 'local') : null;
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

    private freshnessToken(localPath: string, cachedMtime?: number): string {
        const stat = fs.stat(localPath);
        return `${String(cachedMtime ?? stat.mtim)}:${stat.size}`;
    }

    private isFreshMtime(localPath: string, mtPath: string, cachedMtime?: number): boolean {
        try {
            const cachedMt = engine.decodeString(fs.readFile(mtPath));
            return cachedMt === this.freshnessToken(localPath, cachedMtime);
        } catch {
            return false;
        }
    }

    private hasFreshFile(paths: { jsc: string; mt: string }, localPath: string, cachedMtime?: number): boolean {
        try {
            if (!this.isFreshMtime(localPath, paths.mt, cachedMtime)) return false;
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

    private writeMtime(localPath: string, mtPath: string): void {
        fs.writeFile(mtPath, engine.encodeString(this.freshnessToken(localPath)));
    }

    private writeCacheFile(paths: { jsc: string; mt: string }, localPath: string, bytecode: ArrayBuffer): void {
        ensureDir(dirname(paths.jsc));
        fs.writeFile(paths.jsc, bytecode);
        this.writeMtime(localPath, paths.mt);
    }

    load(localPath: string, remote: boolean, cachedMtime?: number): CModuleEngine.Module | null {
        return this.loadRaw(localPath, remote, cachedMtime) as CModuleEngine.Module | null;
    }

    /** load() for non-Module values (e.g. EVAL_COMPILE_ONLY); raw deserialize. */
    loadCompiled(localPath: string, remote: boolean, cachedMtime?: number): unknown | null {
        return this.loadRaw(localPath, remote, cachedMtime);
    }

    private loadRaw(localPath: string, remote: boolean, cachedMtime?: number): unknown | null {
        // L1a: owned buffers (precompile one-shot)
        const bc = this.memory.get(localPath);
        if (bc) {
            try {
                const mod = engine.deserialize(new Uint8Array(bc));
                this.memory.delete(localPath);
                return mod;
            } catch {
                log.debug('jsc', () => `memory deserialize failed: ${localPath}`);
                this.memory.delete(localPath);
            }
        }

        // L1b: active VFS bytecode() — 0-copy view, deserialize on demand
        const view = getMemoryBytecode(localPath);
        if (view) {
            try {
                return engine.deserialize(view);
            } catch {
                log.debug('jsc', () => `vfs bytecode deserialize failed: ${localPath}`);
                // Fall through: source recompile (ABI mismatch / corrupt blob).
            }
        }

        // L2: on-disk only for real filesystem paths
        if (remote) {
            const paths = this.remoteCachePaths(localPath);
            if (!paths) return null;
            if (!this.isFreshMtime(localPath, paths.mt, cachedMtime)) {
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

        const paths = this.localCachePath(localPath);
        if (!paths) return null;

        try {
            const cachedMt = engine.decodeString(fs.readFile(paths.mt));
            if (cachedMt !== this.freshnessToken(localPath, cachedMtime)) {
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
    loadRawBytes(localPath: string, remote: boolean, cachedMtime?: number): ArrayBuffer | null {
        const paths = remote ? this.remoteCachePaths(localPath) : this.localCachePath(localPath);
        if (!paths) return null;
        if (!this.hasFreshFile(paths, localPath, cachedMtime)) return null;
        try {
            return fs.readFile(paths.jsc);
        } catch {
            return null;
        }
    }

    /** Freshness without deserializing (precache gate). */
    hasFresh(localPath: string, remote: boolean, cachedMtime?: number): boolean {
        if (remote) {
            const paths = this.remoteCachePaths(localPath);
            return paths ? this.hasFreshFile(paths, localPath, cachedMtime) : false;
        }
        const paths = this.localCachePath(localPath);
        if (!paths) return false;
        return this.hasFreshFile(paths, localPath, cachedMtime);
    }

    clearMemory(): void {
        this.memory.clear();
    }

    setMemory(localPath: string, bc: ArrayBuffer): void {
        this.memory.set(localPath, bc);
    }

    persistBytecode(localPath: string, bc: ArrayBuffer, remote: boolean): void {
        if (remote) {
            const paths = this.remoteCachePaths(localPath);
            if (!paths) return;
            try {
                this.writeCacheFile(paths, localPath, bc);
            } catch (e) { log.warn('jsc', `persist failed: ${paths.jsc}`, e); }
            return;
        }
        const paths = this.localCachePath(localPath);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc);
        } catch (e) { log.warn('jsc', `persistBytecode failed: ${paths.jsc}`, e); }
    }

    persistMemory(localPath: string): void {
        const bc = this.memory.get(localPath);
        if (!bc) return;
        const paths = this.remoteCachePaths(localPath);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc);
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    persist(localPath: string, mod: CModuleEngine.Module): void {
        const paths = this.remoteCachePaths(localPath);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump());
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    persistLocal(localPath: string, mod: CModuleEngine.Module): void {
        const paths = this.localCachePath(localPath);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump());
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
