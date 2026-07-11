import { dirname, joinPaths, ensureDir, log } from '../utils';

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
        || specPath.startsWith('node:');
}

export class JscCache {
    private readonly memory = new Map<string, ArrayBuffer>();
    private readonly localDir: string | null;

    constructor(cacheDir?: string) {
        this.localDir = cacheDir ? joinPaths(cacheDir, 'local') : null;
    }

    // -------------------------------------------------------------------------
    // Local cache path: {cacheDir}/local/{hash[0:2]}/{hash}.jsc
    // -------------------------------------------------------------------------

    private localCachePath(localPath: string): { jsc: string; mt: string } | null {
        if (!this.localDir) return null;
        const hash = crypto.hexEncode(crypto.md5(engine.encodeString(localPath)));
        const dir = joinPaths(this.localDir, hash.slice(0, 2));
        const base = joinPaths(dir, hash);
        return { jsc: base + '.jsc', mt: base + '.jsc.mt' };
    }

    // -------------------------------------------------------------------------
    // Load: L1 (memory) → L2 (disk .jsc) → null
    // -------------------------------------------------------------------------

    private remoteCachePaths(localPath: string): { jsc: string; mt: string } {
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
        // L1: in-memory bytecode
        const bc = this.memory.get(localPath);
        if (bc) {
            try {
                const mod = engine.deserialize(new Uint8Array(bc)) as CModuleEngine.Module;
                this.memory.delete(localPath);
                return mod;
            } catch (e) {
                log.debug('jsc', () => `memory deserialize failed: ${localPath}`);
                this.memory.delete(localPath);
            }
        }

        // L2: on-disk
        if (remote) {
            const paths = this.remoteCachePaths(localPath);
            if (!this.isFreshMtime(localPath, paths.mt, cachedMtime)) {
                removeCacheFiles(paths);
                return null;
            }
            try {
                return engine.deserialize(new Uint8Array(fs.readFile(paths.jsc))) as CModuleEngine.Module;
            } catch {
                removeCacheFiles(paths);
                return null;
            }
        }

        // Local: .jsc in cacheDir, mtime-validated
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
            return engine.deserialize(new Uint8Array(fs.readFile(paths.jsc))) as CModuleEngine.Module;
        } catch {
            log.debug('jsc', () => `disk deserialize failed: ${paths.jsc}`);
            removeCacheFiles(paths);
            return null;
        }
    }

    /**
     * Fast freshness check used by precache before scheduling precompile work.
     * This avoids deserializing bytecode just to decide whether the file should
     * be regenerated.
     */
    hasFresh(localPath: string, remote: boolean, cachedMtime?: number): boolean {
        if (remote) {
            return this.hasFreshFile(this.remoteCachePaths(localPath), localPath, cachedMtime);
        }

        const paths = this.localCachePath(localPath);
        if (!paths) return false;
        return this.hasFreshFile(paths, localPath, cachedMtime);
    }

    /**
     * Clear all in-memory bytecode (for memory cleanup)
     */
    clearMemory(): void {
        this.memory.clear();
    }

    // -------------------------------------------------------------------------
    // Store bytecode in memory (called by the parse driver)
    // -------------------------------------------------------------------------

    setMemory(localPath: string, bc: ArrayBuffer): void {
        this.memory.set(localPath, bc);
    }

    // -------------------------------------------------------------------------
    // Persist bytecode straight to disk without keeping it in memory.
    // Used by precache: remote → next to file, local → cacheDir + mtime sidecar.
    // -------------------------------------------------------------------------

    persistBytecode(localPath: string, bc: ArrayBuffer, remote: boolean): void {
        if (remote) {
            const paths = this.remoteCachePaths(localPath);
            try {
                this.writeCacheFile(paths, localPath, bc);
            }
            catch (e) { log.warn('jsc', `persist failed: ${paths.jsc}`, e); }
            return;
        }
        const paths = this.localCachePath(localPath);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc);
        } catch (e) { log.warn('jsc', `persistBytecode failed: ${paths.jsc}`, e); }
    }

    // -------------------------------------------------------------------------
    // Persist in-memory bytecode to .jsc file (called after precompile)
    // -------------------------------------------------------------------------

    persistMemory(localPath: string): void {
        const bc = this.memory.get(localPath);
        if (!bc) return;
        const paths = this.remoteCachePaths(localPath);
        try {
            this.writeCacheFile(paths, localPath, bc);
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    // -------------------------------------------------------------------------
    // Persist remote module bytecode (next to local file)
    // -------------------------------------------------------------------------

    persist(localPath: string, mod: CModuleEngine.Module): void {
        const paths = this.remoteCachePaths(localPath);
        try {
            this.writeCacheFile(paths, localPath, mod.dump());
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    // -------------------------------------------------------------------------
    // Persist local file bytecode to cacheDir with mtime sidecar
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Clear local bytecode cache (full wipe of {cacheDir}/local/)
    // -------------------------------------------------------------------------

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
