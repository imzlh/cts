/** Import specs: oxc-first on main thread; workers only if oxc missing + opted in. */
import type { OxcTranspiler } from './oxc';
import { extractImports, isTsLikePath, isWasmPath } from './scan';
import { scanWasmImportModules } from './wasm-imports';
import { errMsg, log, readText } from './utils';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');

function isTypeScriptLanguage(lang: string | undefined, localPath: string): boolean {
    if (!lang) return isTsLikePath(localPath);
    const normalized = (lang.startsWith('.') ? lang.slice(1) : lang).toLowerCase();
    return normalized === 'ts' || normalized === 'tsx' || normalized === 'cts' || normalized === 'mts';
}

export class ImportScanner {
    private fallbackLogged = false;

    constructor(private readonly oxc: OxcTranspiler | null) {}

    /** Sync scan of an on-disk file. Prefer this for oxc (no worker pool). */
    scanFile(localPath: string, lang?: string): string[] {
        try {
            const bytes = new Uint8Array(fs.readFile(localPath));
            return this.scanBytes(bytes, localPath, lang);
        } catch (e) {
            log.debug('scan', () => `read fail ${localPath}: ${errMsg(e)}`);
            return [];
        }
    }

    scanBytes(bytes: Uint8Array, localPath: string, lang?: string): string[] {
        // WASM: import section module names are static deps (same as JS import specs).
        if (isWasmPath(localPath)) return scanWasmImportModules(bytes);

        if (this.oxc) {
            try {
                const deps = this.oxc.scanImportsBytes(bytes, localPath);
                if (deps !== null) return deps;
            } catch (e) {
                log.debug('oxc', () => `scanImportsBytes ${localPath}: ${errMsg(e)}`);
            }
            try {
                const source = engine.decodeString(bytes);
                const deps = this.oxc.scanImports(source, localPath);
                if (deps !== null) return deps;
            } catch (e) {
                log.debug('oxc', () => `scanImports ${localPath}: ${errMsg(e)}`);
            }
            if (!this.fallbackLogged) {
                this.fallbackLogged = true;
                log.debug('oxc', () => `scan fallback to sucrase (first: ${localPath})`);
            }
            return extractImports(engine.decodeString(bytes), isTypeScriptLanguage(lang, localPath));
        }
        return extractImports(engine.decodeString(bytes), isTypeScriptLanguage(lang, localPath));
    }

    scanSource(source: string, localPath: string, lang?: string): string[] {
        if (this.oxc) {
            try {
                const deps = this.oxc.scanImports(source, localPath);
                if (deps !== null) return deps;
            } catch (e) {
                log.debug('oxc', () => `scanImports ${localPath}: ${errMsg(e)}`);
            }
            if (!this.fallbackLogged) {
                this.fallbackLogged = true;
                log.debug('oxc', () => `scan fallback to sucrase (first: ${localPath})`);
            }
        }
        return extractImports(source, isTypeScriptLanguage(lang, localPath));
    }

    /** Text-path convenience used by tests / fallbacks. */
    scanTextFile(localPath: string, lang?: string): string[] {
        try {
            return this.scanSource(readText(localPath), localPath, lang);
        } catch (e) {
            log.debug('scan', () => `readText fail ${localPath}: ${errMsg(e)}`);
            return [];
        }
    }
}
