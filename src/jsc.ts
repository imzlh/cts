// jsc.ts — JSC bytecode cache (compilation artifact management)
//
// Two-tier cache:
//   L1  in-memory bytecode (from precompile workers, same-process only)
//   L2  on-disk .jsc files   (persisted, survives process restart)
//
// Cacheable modules: remote (npm:, jsr:, http:, https:) + node: polyfills.
// Local user files are never cached — users change them frequently,
// and mtime checking adds overhead for no benefit.
// Node polyfills are runtime-provided and never modified by users.

import { dirname } from './utils/path';
import { ensureDir } from './utils/io';
import { log } from './utils/log';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

export function isRemote(specPath: string): boolean {
    return specPath.startsWith('http://') || specPath.startsWith('https://')
        || specPath.startsWith('jsr:') || specPath.startsWith('npm:')
        || specPath.startsWith('node:');
}

export class JscCache {
    private readonly memory = new Map<string, ArrayBuffer>();

    // -------------------------------------------------------------------------
    // Load: L1 (memory) → L2 (disk .jsc) → null
    // -------------------------------------------------------------------------

    load(localPath: string, remote: boolean): CModuleEngine.Module | null {
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

        if (!remote) return null;

        const jscPath = localPath + '.jsc';
        if (!fs.exists(jscPath)) return null;
        try {
            const bytes = fs.readFile(jscPath);
            return engine.deserialize(new Uint8Array(bytes)) as CModuleEngine.Module;
        } catch {
            log.debug('jsc', () => `disk deserialize failed: ${jscPath}`);
            try { fs.unlink(jscPath); } catch { /* ignore */ }
            return null;
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
    // Persist a compiled module to .jsc (called from loadEsm fallback)
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
}