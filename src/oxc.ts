import { log } from './utils/log';
import { errMsg } from './utils/misc';

const os = import.meta.use('os');
const fs = import.meta.use('fs');

// ── oxc native extension types ────────────────────────────────────────────────

export interface OxcModule {
    transpile(source: string, opts?: { kind?: 'js' | 'jsx' | 'ts' | 'tsx'; depsOnly?: boolean }): { code: string; deps: string[] };
    scanImports(source: string, opts?: { kind?: 'js' | 'jsx' | 'ts' | 'tsx' }): string[];
    version: string;
}

// ── OxcTranspiler — wraps the native oxc extension ───────────────────────────

export class OxcTranspiler {
    private mod: OxcModule;

    constructor(mod: OxcModule) {
        this.mod = mod;
        log.debug('oxc', () => `loaded ${mod.version}`);
    }

    /** Transpile TS/TSX/JS/JSX to JS. Returns null if the extension errors. */
    transpile(source: string, filename: string): string | null {
        try {
            const kind = kindFromFilename(filename);
            const { code } = this.mod.transpile(source, { kind });
            return code;
        } catch (e) {
            log.debug('oxc', () => `transpile failed for ${filename}: ${errMsg(e)}`);
            return null;
        }
    }

    /** Extract import specifiers without full codegen. */
    scanImports(source: string, filename: string): string[] | null {
        try {
            const kind = kindFromFilename(filename);
            return this.mod.scanImports(source, { kind });
        } catch (e) {
            log.debug('oxc', () => `scanImports failed for ${filename}: ${errMsg(e)}`);
            return null;
        }
    }
}

function kindFromFilename(filename: string): 'js' | 'jsx' | 'ts' | 'tsx' {
    if (filename.endsWith('.tsx')) return 'tsx';
    if (filename.endsWith('.ts'))  return 'ts';
    if (filename.endsWith('.jsx')) return 'jsx';
    return 'js';
}

/**
 * Resolve path to the OXC native extension.
 * Prefers <exeDir>/ext/oxc.{dll,so,dylib}; falls back to legacy swc.* name.
 * Returns null if neither exists.
 */
export function oxcExtPath(): string | null {
    try {
        const exeDir = os.exePath.replace(/[\\/][^\\/]+$/, '');
        const sep = os.platform === 'windows' ? '\\' : '/';
        const suffix = os.platform === 'windows' ? 'dll'
                     : os.platform === 'darwin'  ? 'dylib'
                     : 'so';
        const preferred = `${exeDir}${sep}ext${sep}oxc.${suffix}`;
        const legacy    = `${exeDir}${sep}ext${sep}swc.${suffix}`;

        // Check preferred name first (future build output)
        try {
            // Use a quick stat via os if available; otherwise fall through to legacy
            if (fs.stat?.(preferred)) return preferred;
        } catch {}

        try {
            if (fs.stat?.(legacy)) {
                log.debug('oxc', () => `using legacy ext path: ${legacy}`);
                return legacy;
            }
        } catch {}

        log.debug('oxc', () => `native extension not found: ${preferred} or ${legacy}`);
        return null;
    } catch {
        return null;
    }
}

/** Try to load and register the oxc native extension.
 *  Returns an OxcTranspiler on success, null if not found or failed to load. */
export function tryLoadOxc(): OxcTranspiler | null {
    const extPath = oxcExtPath();
    if (!extPath) return null;

    try {
        import.meta.register('oxc', extPath);
        const oxcMod = import.meta.use('oxc') as any as OxcModule;
        if (typeof oxcMod?.transpile !== 'function') {
            log.debug('oxc', () => `register succeeded but module API unexpected`);
            return null;
        }
        return new OxcTranspiler(oxcMod);
    } catch (e) {
        log.debug('oxc', () => `not available at ${extPath}: ${errMsg(e)}`);
        return null;
    }
}
