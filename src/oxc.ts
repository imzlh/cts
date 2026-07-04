import { log, errMsg } from './utils';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const smap = import.meta.use('sourcemap');

// ── oxc native extension types ────────────────────────────────────────────────

export interface OxcModule {
    transpile(source: string, opts?: { kind?: 'js' | 'jsx' | 'ts' | 'tsx'; depsOnly?: boolean; filename?: string }): { code: string; deps: string[]; sourceMap?: string };
    scanImports(source: string, opts?: { kind?: 'js' | 'jsx' | 'ts' | 'tsx' }): string[];
    version: string;
}

// ── OxcTranspiler — wraps the native oxc extension ───────────────────────────

export class OxcTranspiler {
    private mod: OxcModule;
    private scanLogged = false;

    constructor(mod: OxcModule) {
        this.mod = mod;
        log.debug('oxc', () => `loaded ${mod.version}`);
    }

    /** Transpile TS/TSX/JS/JSX to JS. Returns null if the extension errors.
     *  `mapKey` is the module's runtime identity (e.g. specPath) — the same
     *  name passed to `new engine.Module(code, mapKey)`. It is used both as
     *  the sourcemap registry key AND as the embedded `sources` entry, so a
     *  resolved stack frame shows that identity instead of the on-disk path
     *  `filename` (which may sit in a shared, unrelated cache directory). */
    transpile(source: string, filename: string, mapKey?: string): string | null {
        try {
            const kind = kindFromFilename(filename);
            const name = mapKey ?? filename;
            const { code, sourceMap } = this.mod.transpile(source, { kind, filename: name });
            if (sourceMap) {
                try { smap.loadJSON(name, sourceMap); }
                catch (e) { log.debug('oxc', () => `smap: ${filename}: ${errMsg(e)}`); }
            }
            return code;
        } catch (e) {
            log.debug('oxc', () => `transpile failed for ${filename}: ${errMsg(e)}`);
            return null;
        }
    }

    /** Like transpile(), but returns the sourcemap instead of registering it
     *  locally — for callers (e.g. a worker) whose JSContext isn't the one
     *  that will actually run the compiled module and needs to register it. */
    transpileCapture(source: string, filename: string, mapKey?: string): { code: string; sourceMap?: string } | null {
        try {
            const kind = kindFromFilename(filename);
            const { code, sourceMap } = this.mod.transpile(source, { kind, filename: mapKey ?? filename });
            return { code, sourceMap };
        } catch (e) {
            log.debug('oxc', () => `transpile failed for ${filename}: ${errMsg(e)}`);
            return null;
        }
    }

    /** Extract import specifiers without full codegen. */
    scanImports(source: string, filename: string): string[] | null {
        try {
            const kind = kindFromFilename(filename);
            const deps = this.mod.scanImports(source, { kind });
            if (!this.scanLogged) {
                this.scanLogged = true;
                log.debug('oxc', () => `scan active: ${filename}`);
            }
            return deps;
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
 * Returns null if not found.
 */
export function oxcExtPath(): string | null {
    try {
        const exeDir = os.exePath.replace(/[\\/][^\\/]+$/, '');
        const sep = os.platform === 'windows' ? '\\' : '/';
        const suffix = os.platform === 'windows' ? 'dll'
                     : os.platform === 'darwin'  ? 'dylib'
                     : 'so';
        const extPath = `${exeDir}${sep}ext${sep}oxc.${suffix}`;
        const candidates = [extPath];
        const stageSuffix = `${sep}build${sep}stage`;

        if (exeDir.endsWith(stageSuffix)) {
            const repoRoot = exeDir.slice(0, -stageSuffix.length);
            candidates.push(`${repoRoot}${sep}ext-oxc${sep}build${sep}oxc.${suffix}`);
        }

        for (const path of candidates) {
            try {
                if (fs.stat?.(path)) return path;
            } catch {}
        }

        log.debug('oxc', () => `native extension not found: ${candidates.join(', ')}`);
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
