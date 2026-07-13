import type CModuleExternalOxc from '../../ext-oxc/native';
import { log, errMsg } from './utils';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const smap = import.meta.use('sourcemap');
const console = import.meta.use('console');

// ── oxc native extension types ────────────────────────────────────────────────

export interface OxcModule {
    transpile(source: string, opts?: OxcOptions): { code: string; deps: string[]; sourceMap?: string };
    scanImports(source: string, opts?: OxcOptions): string[];
    transpileFast?: (source: string, kind: OxcKind, filename: string) => OxcTransformResult;
    transpileBytes?: (source: Uint8Array, kind: OxcKind, filename: string) => OxcTransformResult;
    transpileSharedBytes?: (source: Uint8Array, kind: OxcKind, filename: string) => OxcSharedBytesResult;
    scanImportsFast?: (source: string, kind: OxcKind) => string[];
    scanImportsBytes?: (source: Uint8Array, kind: OxcKind) => string[];
    version: string;
}

interface OxcTransformResult {
    code: string;
    sourceMap?: string;
}

interface OxcSharedBytesResult {
    code: Uint8Array;
    sourceMap?: Uint8Array;
}

type OxcKind = 0 | 1 | 2 | 3;
type OxcOptionKind = 'js' | 'jsx' | 'ts' | 'tsx';

interface OxcOptions {
    kind?: OxcOptionKind;
    depsOnly?: boolean;
    filename?: string;
}

const OXC_KIND_JS = 0;
const OXC_KIND_JSX = 1;
const OXC_KIND_TS = 2;
const OXC_KIND_TSX = 3;

const OXC_SCAN_JS_OPTIONS: OxcOptions = { kind: 'js' };
const OXC_SCAN_JSX_OPTIONS: OxcOptions = { kind: 'jsx' };
const OXC_SCAN_TS_OPTIONS: OxcOptions = { kind: 'ts' };
const OXC_SCAN_TSX_OPTIONS: OxcOptions = { kind: 'tsx' };
const REGISTER_SYMBOL = Symbol.for('cjs.internal.register');

type NativeRegister = (name: string, path: string) => void;

export function isOxcModule(value: unknown): value is OxcModule {
    return value !== null
        && typeof value === 'object'
        && typeof Reflect.get(value, 'transpile') === 'function'
        && typeof Reflect.get(value, 'scanImports') === 'function'
        && typeof Reflect.get(value, 'version') === 'string';
}

// ── OxcTranspiler — wraps the native oxc extension ───────────────────────────

export class OxcTranspiler {
    private mod: OxcModule;
    private transpileOptions: OxcOptions = { kind: 'js', filename: '' };
    private transpileFast: ((source: string, kind: OxcKind, filename: string) => OxcTransformResult) | null = null;
    private transpileBytesFn: ((source: Uint8Array, kind: OxcKind, filename: string) => OxcTransformResult) | null = null;
    private transpileSharedBytesFn: ((source: Uint8Array, kind: OxcKind, filename: string) => OxcSharedBytesResult) | null = null;
    private scanImportsFast: ((source: string, kind: OxcKind) => string[]) | null = null;
    private scanImportsBytesFn: ((source: Uint8Array, kind: OxcKind) => string[]) | null = null;
    private scanLogged = false;

    constructor(mod: OxcModule) {
        this.mod = mod;
        const transpileFast = Reflect.get(mod, 'transpileFast');
        if (typeof transpileFast === 'function') {
            this.transpileFast = transpileFast;
        }
        const transpileBytes = Reflect.get(mod, 'transpileBytes');
        if (typeof transpileBytes === 'function') {
            this.transpileBytesFn = transpileBytes;
        }
        const transpileSharedBytes = Reflect.get(mod, 'transpileSharedBytes');
        if (typeof transpileSharedBytes === 'function') {
            this.transpileSharedBytesFn = transpileSharedBytes;
        }
        const scanImportsFast = Reflect.get(mod, 'scanImportsFast');
        if (typeof scanImportsFast === 'function') {
            this.scanImportsFast = scanImportsFast;
        }
        const scanImportsBytes = Reflect.get(mod, 'scanImportsBytes');
        if (typeof scanImportsBytes === 'function') {
            this.scanImportsBytesFn = scanImportsBytes;
        }
        log.debug('oxc', () => `loaded ${mod.version}`);
    }

    /** Transpile TS/TSX/JS/JSX to JS. Returns null if the extension errors.
     *  `mapKey` is the module's runtime identity (e.g. specPath) — the same
     *  name passed to `new engine.Module(code, mapKey)`. It is used both as
     *  the sourcemap registry key AND as the embedded `sources` entry, so a
     *  resolved stack frame shows that identity instead of the on-disk path
     *  `filename` (which may sit in a shared, unrelated cache directory). */
    transpile(source: string, filename: string, mapKey?: string, lang?: string): string | null {
        try {
            const kind = kindFromFilename(filename, lang);
            const name = mapKey ?? filename;
            const { code, sourceMap } = this.transpileFast
                ? this.transpileFast(source, kind, name)
                : this.transpileCompat(source, kind, name);
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
    transpileCapture(source: string, filename: string, mapKey?: string, lang?: string): { code: string; sourceMap?: string } | null {
        try {
            const kind = kindFromFilename(filename, lang);
            const name = mapKey ?? filename;
            const { code, sourceMap } = this.transpileFast
                ? this.transpileFast(source, kind, name)
                : this.transpileCompat(source, kind, name);
            return { code, sourceMap };
        } catch (e) {
            log.debug('oxc', () => `transpile failed for ${filename}: ${errMsg(e)}`);
            return null;
        }
    }

    transpileBytes(source: Uint8Array, filename: string, mapKey?: string, lang?: string): OxcTransformResult | OxcSharedBytesResult | null {
        if (!this.transpileSharedBytesFn && !this.transpileBytesFn) return null;
        try {
            const kind = kindFromFilename(filename, lang);
            const name = mapKey ?? filename;
            return this.transpileSharedBytesFn
                ? this.transpileSharedBytesFn(source, kind, name)
                : this.transpileBytesFn!(source, kind, name);
        } catch (e) {
            log.debug('oxc', () => `transpileBytes failed for ${filename}: ${errMsg(e)}`);
            return null;
        }
    }

    /** Extract import specifiers without full codegen. */
    scanImports(source: string, filename: string): string[] | null {
        try {
            const kind = kindFromFilename(filename);
            const deps = this.scanImportsFast
                ? this.scanImportsFast(source, kind)
                : this.mod.scanImports(source, scanOptionsForKind(kind));
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

    scanImportsBytes(source: Uint8Array, filename: string): string[] | null {
        if (!this.scanImportsBytesFn) return null;
        try {
            const deps = this.scanImportsBytesFn(source, kindFromFilename(filename));
            if (!this.scanLogged) {
                this.scanLogged = true;
                log.debug('oxc', () => `scan active: ${filename}`);
            }
            return deps;
        } catch (e) {
            log.debug('oxc', () => `scanImportsBytes failed for ${filename}: ${errMsg(e)}`);
            return null;
        }
    }

    private transpileCompat(source: string, kind: OxcKind, filename: string): OxcTransformResult {
        const opts = this.transpileOptions;
        opts.kind = optionKindForKind(kind);
        opts.filename = filename;
        return this.mod.transpile(source, opts);
    }
}

function kindFromFilename(filename: string, lang?: string): OxcKind {
    if (lang === 'ts' || lang === 'mts' || lang === 'cts') return OXC_KIND_TS;
    if (lang === 'tsx') return OXC_KIND_TSX;
    if (lang === 'jsx') return OXC_KIND_JSX;
    const length = filename.length;
    if (length >= 3 &&
        filename.charCodeAt(length - 1) === 115 &&
        filename.charCodeAt(length - 2) === 116) {
        const third = filename.charCodeAt(length - 3);
        if (third === 46 ||
            (length >= 4 &&
                (third === 109 || third === 99) &&
                filename.charCodeAt(length - 4) === 46)) {
            return OXC_KIND_TS;
        }
    }
    if (length >= 4 &&
        filename.charCodeAt(length - 1) === 120 &&
        filename.charCodeAt(length - 2) === 115 &&
        filename.charCodeAt(length - 4) === 46) {
        const lang = filename.charCodeAt(length - 3);
        if (lang === 116) return OXC_KIND_TSX;
        if (lang === 106) return OXC_KIND_JSX;
    }
    return OXC_KIND_JS;
}

function scanOptionsForKind(kind: OxcKind): OxcOptions {
    switch (kind) {
        case OXC_KIND_TS: return OXC_SCAN_TS_OPTIONS;
        case OXC_KIND_TSX: return OXC_SCAN_TSX_OPTIONS;
        case OXC_KIND_JSX: return OXC_SCAN_JSX_OPTIONS;
        default: return OXC_SCAN_JS_OPTIONS;
    }
}

function optionKindForKind(kind: OxcKind): OxcOptionKind {
    switch (kind) {
        case OXC_KIND_TS: return 'ts';
        case OXC_KIND_TSX: return 'tsx';
        case OXC_KIND_JSX: return 'jsx';
        default: return 'js';
    }
}

/**
 * Resolve path to the OXC native extension.
 * Mirrors bootstrap resolveExtDir: CTS_EXT_PATH, <exe>/ext, <exe>/lib/ext.
 */
export function oxcExtPath(): string | null {
    try {
        const sep = os.platform === 'windows' ? '\\' : '/';
        const suffix = os.platform === 'windows' ? 'dll'
                     : os.platform === 'darwin'  ? 'dylib'
                     : 'so';
        const file = `oxc.${suffix}`;
        const candidates: string[] = [];

        // CTS_EXT_PATH (same env var bootstrap.ts's resolveExtDir() honors) wins.
        let envDir: string | null = null;
        try { envDir = os.getenv('CTS_EXT_PATH'); } catch {}
        if (envDir) candidates.push(`${envDir.replace(/[\\/]+$/, '')}${sep}${file}`);

        const exeDir = os.exePath.replace(/[\\/][^\\/]+$/, '');
        candidates.push(`${exeDir}${sep}ext${sep}${file}`);
        candidates.push(`${exeDir}${sep}lib${sep}ext${sep}${file}`);

        for (const path of candidates) {
            try {
                if (fs.exists(path) && fs.stat(path).isFile) return path;
            } catch {}
        }

        log.debug('oxc', () => `native extension not found: ${candidates.join(', ')}`);
        return null;
    } catch {
        return null;
    }
}

let localOxc: OxcTranspiler | null = null;

function wrapOxc(mod: unknown): OxcTranspiler | null {
    if (!isOxcModule(mod)) return null;
    localOxc = new OxcTranspiler(mod);
    return localOxc;
}

/** import.meta.use returns null (not throw) when the name is unknown. */
function useRegisteredOxc(): OxcTranspiler | null {
    try {
        return wrapOxc(import.meta.use('oxc'));
    } catch (e) {
        log.debug('oxc', () => `use('oxc') failed: ${errMsg(e)}`);
        return null;
    }
}

function registerOxcPath(extPath: string): boolean {
    try {
        import.meta.register('oxc', extPath);
        return true;
    } catch (e) {
        const msg = errMsg(e);
        // Bootstrap / concurrent register is success for our purposes.
        if (/already registered|built-in/i.test(msg)) return true;
        log.debug('oxc', () => `register failed at ${extPath}: ${msg}`);
        return false;
    }
}

/** Try to load the oxc native extension (register if needed).
 *  Returns an OxcTranspiler on success, null if not found or failed to load.
 *
 *  Order matters:
 *  1. use() — cno bootstrap already put `oxc` in dyn_registry (or static)
 *  2. register(path) then use() — standalone cts / missing bootstrap entry
 *  Never treat "already registered" as unavailable (that forced Sucrase). */
export function tryLoadOxc(): OxcTranspiler | null {
    if (localOxc) return localOxc;

    const existing = useRegisteredOxc();
    if (existing) return existing;

    const extPath = oxcExtPath();
    if (!extPath) return null;
    if (!registerOxcPath(extPath)) return null;

    const loaded = useRegisteredOxc();
    if (loaded) return loaded;
    log.debug('oxc', () => `register path ok but module API unexpected at ${extPath}`);
    return null;
}
