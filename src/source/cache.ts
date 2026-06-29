// jsc.ts — JSC bytecode cache (compilation artifact management)
//
// Two-tier cache:
//   L1  in-memory bytecode (from precompile workers, same-process only)
//   L2  on-disk .jsc files   (persisted, survives process restart)
//
// Remote modules (npm:, jsr:, http:, https:, node:) are cached unconditionally
// next to their local file (localPath + '.jsc').
//
// Local user files (.ts, .tsx, .jsx) are cached in {cacheDir}/local/
// using a path-hash filename.  A .jsc.mt sidecar stores the source mtime;
// on load, the cached bytecode is used only when the source hasn't changed.

import { dirname, joinPaths } from '../utils/path';
import { ensureDir } from '../utils/io';
import { log } from '../utils/log';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

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
            // Remote: .jsc sits next to the local file, no mtime check
            const jscPath = localPath + '.jsc';
            try {
                return engine.deserialize(new Uint8Array(fs.readFile(jscPath))) as CModuleEngine.Module;
            } catch {
                return null;
            }
        }

        // Local: .jsc in cacheDir, mtime-validated
        const paths = this.localCachePath(localPath);
        if (!paths) return null;

        try {
            const cachedMt = engine.decodeString(fs.readFile(paths.mt));
            const currentMt = String(cachedMtime ?? fs.stat(localPath).mtim);
            if (cachedMt !== currentMt) {
                try { fs.unlink(paths.jsc); fs.unlink(paths.mt); } catch {}
                return null;
            }
        } catch {
            try { fs.unlink(paths.jsc); fs.unlink(paths.mt); } catch {}
            return null;
        }

        try {
            return engine.deserialize(new Uint8Array(fs.readFile(paths.jsc))) as CModuleEngine.Module;
        } catch {
            log.debug('jsc', () => `disk deserialize failed: ${paths.jsc}`);
            try { fs.unlink(paths.jsc); fs.unlink(paths.mt); } catch {}
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
            try { return !!fs.stat(localPath + '.jsc'); }
            catch { return false; }
        }

        const paths = this.localCachePath(localPath);
        if (!paths) return false;

        try {
            const cachedMt = engine.decodeString(fs.readFile(paths.mt));
            const currentMt = String(cachedMtime ?? fs.stat(localPath).mtim);
            if (cachedMt !== currentMt) return false;
            return !!fs.stat(paths.jsc);
        } catch {
            return false;
        }
    }

    /**
     * Clear all in-memory bytecode (for memory cleanup)
     */
    clearMemory(): void {
        this.memory.clear();
    }

    // -------------------------------------------------------------------------
    // Store bytecode in memory (called by precompile driver)
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
            const jscPath = localPath + '.jsc';
            try { ensureDir(dirname(jscPath)); fs.writeFile(jscPath, bc); }
            catch (e) { log.warn('jsc', `persist failed: ${jscPath}`, e); }
            return;
        }
        const paths = this.localCachePath(localPath);
        if (!paths) return;
        try {
            ensureDir(dirname(paths.jsc));
            fs.writeFile(paths.jsc, bc);
            fs.writeFile(paths.mt, engine.encodeString(String(fs.stat(localPath).mtim)));
        } catch (e) { log.warn('jsc', `persistBytecode failed: ${paths.jsc}`, e); }
    }

    // -------------------------------------------------------------------------
    // Persist in-memory bytecode to .jsc file (called after precompile)
    // -------------------------------------------------------------------------

    persistMemory(localPath: string): void {
        const bc = this.memory.get(localPath);
        if (!bc) return;
        const jscPath = localPath + '.jsc';
        try {
            ensureDir(dirname(jscPath));
            fs.writeFile(jscPath, bc);
        } catch (e) {
            log.warn('jsc', `persist failed: ${jscPath}`, e);
        }
    }

    // -------------------------------------------------------------------------
    // Persist remote module bytecode (next to local file)
    // -------------------------------------------------------------------------

    persist(localPath: string, mod: CModuleEngine.Module): void {
        const jscPath = localPath + '.jsc';
        try {
            ensureDir(dirname(jscPath));
            fs.writeFile(jscPath, mod.dump());
        } catch (e) {
            log.warn('jsc', `persist failed: ${jscPath}`, e);
        }
    }

    // -------------------------------------------------------------------------
    // Persist local file bytecode to cacheDir with mtime sidecar
    // -------------------------------------------------------------------------

    persistLocal(localPath: string, mod: CModuleEngine.Module): void {
        const paths = this.localCachePath(localPath);
        if (!paths) return;
        try {
            ensureDir(dirname(paths.jsc));
            fs.writeFile(paths.jsc, mod.dump());
            const mt = fs.stat(localPath).mtim;
            fs.writeFile(paths.mt, engine.encodeString(String(mt)));
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
                try {
                    if (fs.stat(p).isDirectory) {
                        for (const f of fs.readdir(p)) {
                            try { fs.unlink(joinPaths(p, f)); } catch {}
                        }
                        try { fs.rmdir(p); } catch {}
                    }
                } catch {}
            }
            log.debug('jsc', () => `cleared local cache: ${this.localDir}`);
        } catch (e) {
            log.debug('jsc', () => `clearLocal failed: ${e}`);
        }
    }
}
