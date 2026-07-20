import type { RuntimeConfig, ConfigOptions } from './types';
import { dirname, joinPaths, normalizePath, toPosixPath, readText, writeText, ensureDir, stripJsonc, safeParse, parseArgs, log, uname, isWindows, getMemoryTier, isRelative } from './utils';
import { err, ErrorKind } from './errors';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const timers = import.meta.use('timers');

// Defaults (only truly required fields)

const DEFAULTS = {
    enableHttp:  true,
    enableJsr:   true,
    enableNode:  true,
    silent:      false,
    jsrCacheTTL: 7 * 24 * 60 * 60 * 1000,
    // Large registry tarballs (multi-MB) often need >30s on slow links.
    requestTimeout: 120000,
    enableCache: true,
    cachedOnly: false,
    enableOxc: true,
    ignoreScripts: false,
    nodeModulesMode: 'normal',
    polyfill:    '',
    cacheDir:    '',
} as const;

// Tier-based runtime defaults (applied when no explicit CLI/env override)

const TIER_MEM_LIMIT: Record<string, number> = {
    low:    32 * 1024 * 1024,  // 32 MB
    normal: 256 * 1024 * 1024, // 256 MB
    high:   0,                 // unlimited
};

const TIER_STACK_SIZE: Record<string, number> = {
    low:     2 * 1024 * 1024,  // 2 MB
    normal:  4 * 1024 * 1024,  // 4 MB
    high:    6 * 1024 * 1024,  // 6 MB
};

const DEFAULT_MEM_LIMIT = TIER_MEM_LIMIT.normal;
const DEFAULT_STACK_SIZE = TIER_STACK_SIZE.normal;

// Memory size parser  "256MB" → bytes

export function parseSize(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)?$/i);
    if (!m) throw err(ErrorKind.InvalidSpecifier, `Invalid size "${s}" — use e.g. 256MB, 1GB, 4MB`);
    const value = m[1];
    if (value === undefined) throw err(ErrorKind.InvalidSpecifier, `Invalid size "${s}" — use e.g. 256MB, 1GB, 4MB`);
    const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
    return Math.floor(parseFloat(value) * (units[(m[2] ?? 'B').toUpperCase()] ?? 1));
}

function env(k: string): string | null {
    try {
        return os.getenv(k) ?? null;
    } catch {
        return null;
    }
}

function resolveImportMapTarget(target: string, baseDir?: string): string {
    if (!baseDir || !isRelative(target)) return target;
    const keepTrailingSlash = target.endsWith('/') || target.endsWith('\\');
    let resolved = normalizePath(joinPaths(baseDir, toPosixPath(target)));
    if (keepTrailingSlash && !resolved.endsWith('/')) resolved += '/';
    return resolved;
}

/** Filter import map entries: keep only string-valued, non-# entries. */
function filterImports(raw: unknown, baseDir?: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('#') && typeof v === 'string') out[k] = resolveImportMapTarget(v, baseDir);
    }
    return out;
}

function filterImportMapScopes(raw: unknown, baseDir: string): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [scope, mappings] of Object.entries(raw)) {
        const filtered = filterImports(mappings, baseDir);
        if (Object.keys(filtered).length === 0) continue;
        out[resolveImportMapTarget(scope, baseDir)] = filtered;
    }
    return out;
}

function mergeImportMapScopes(
    current: Record<string, Record<string, string>> | undefined,
    next: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> | undefined {
    if (Object.keys(next).length === 0) return current;
    const merged = { ...current };
    for (const [scope, mappings] of Object.entries(next)) {
        merged[scope] = { ...merged[scope], ...mappings };
    }
    return merged;
}

interface ConfigJson {
    compilerOptions?: {
        paths?: unknown;
        baseUrl?: unknown;
    };
    imports?: unknown;
    scopes?: unknown;
    importMap?: unknown;
    cts?: {
        nodeModulesMode?: unknown;
    };
}

function filterPathAliases(raw: unknown): Record<string, string[]> | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const out: Record<string, string[]> = {};
    let hasEntries = false;
    for (const [key, value] of Object.entries(raw)) {
        if (!Array.isArray(value)) continue;
        const targets: string[] = [];
        for (let i = 0; i < value.length; i++) {
            const item = value[i];
            if (typeof item === 'string') targets.push(item);
        }
        if (targets.length > 0) {
            out[key] = targets;
            hasEntries = true;
        }
    }
    return hasEntries ? out : undefined;
}

function envConfig(): Partial<ConfigOptions> {
    const c: Partial<ConfigOptions> = {};
    const bool = (v: string | null) => v !== null ? v === 'true' : undefined;
    const E = 'CTS_';
    const v = (k: string) => env(E + k);
    const cacheDir = v('CACHE_DIR'); if (cacheDir) c.cacheDir = cacheDir;
    const lockDir = v('LOCK_DIR'); if (lockDir) c.lockDir = lockDir;
    const dc  = bool(v('DISABLE_CACHE')); if (dc  !== undefined) c.enableCache = !dc;
    // OXC env vars
    const no  = bool(v('NO_OXC'));         if (no === true) c.enableOxc = false;
    const oxc = bool(v('ENABLE_OXC'));     if (oxc !== undefined) c.enableOxc = oxc;
    const http = bool(v('ENABLE_HTTP')); if (http !== undefined) c.enableHttp = http;
    const jsr  = bool(v('ENABLE_JSR'));  if (jsr  !== undefined) c.enableJsr  = jsr;
    const node = bool(v('ENABLE_NODE')); if (node !== undefined) c.enableNode = node;
    const sil  = bool(v('SILENT'));      if (sil  !== undefined) c.silent = sil;
    const ml = v('MEMORY_LIMIT');   if (ml) c.memoryLimit  = parseSize(ml);
    const ms = v('MAX_STACK_SIZE'); if (ms) c.maxStackSize = parseSize(ms);
    const ttl = v('JSR_CACHE_TTL'); if (ttl) c.jsrCacheTTL = +ttl * 24 * 60 * 60 * 1000;
    const rt = v('REQUEST_TIMEOUT'); if (rt) c.requestTimeout = +rt;
    const jsxP = v('JSX_PRAGMA'); if (jsxP) c.jsxPragma = jsxP;
    const jsxF = v('JSX_FRAGMENT_PRAGMA'); if (jsxF) c.jsxFragmentPragma = jsxF;
    return c;
}

function defaultCacheDir(): string {
    let home: string | null = getHomeDir();
    if (!home) home = env(isWindows ? 'USERPROFILE' : 'HOME') ?? '/root';
    return joinPaths(toPosixPath(home), '.cts');
}

function getHomeDir(): string | null {
    try {
        return os.homeDir;
    } catch {
        return null;
    }
}

function statOrNull(path: string): CModuleFS.Stats | null {
    try {
        return fs.stat(path);
    } catch {
        return null;
    }
}

function unlinkQuietly(path: string): void {
    try {
        fs.unlink(path);
    } catch {
        // Ignore best-effort cache cleanup failures.
    }
}

function rmdirQuietly(path: string): void {
    try {
        fs.rmdir(path);
    } catch {
        // Ignore best-effort cache cleanup failures.
    }
}

function readTextOrEmpty(path: string): string {
    try {
        return readText(path);
    } catch {
        return '';
    }
}

function isJscArtifact(path: string): boolean {
    return path.endsWith('.jsc') || path.endsWith('.jsc.mt');
}

function clearJsc(dir: string): void {
    // Delete bytecode artifacts in a background timer so we don't block startup.
    timers.setTimeout(() => {
        try {
            clearJscSync(dir);
        } catch {}
    }, 0);
}

function clearJscSync(dir: string): void {
    try {
        for (const e of fs.readdir(dir)) {
            const p = joinPaths(dir, e);
            const stat = statOrNull(p);
            if (!stat) continue;
            if (stat.isDirectory) {
                clearJscSync(p);
            } else if (isJscArtifact(p)) {
                unlinkQuietly(p);
            }
        }
    } catch {}
}

/** Remove a directory and all contents (used for {cacheDir}/local/ cleanup). */
function rmrf(dir: string): void {
    try {
        for (const e of fs.readdir(dir)) {
            const p = joinPaths(dir, e);
            const stat = statOrNull(p);
            if (!stat) continue;
            if (stat.isDirectory) {
                rmrf(p);
            } else {
                unlinkQuietly(p);
            }
        }
        rmdirQuietly(dir);
    } catch {}
}

function verifyCacheDir(dir: string): void {
    if (!fs.exists(dir)) {
        ensureDir(dir);
        writeText(joinPaths(dir, 'version'), engine.versions.quickjs);
        return;
    }
    const vf = joinPaths(dir, 'version');
    const stored = readTextOrEmpty(vf);
    if (stored !== engine.versions.quickjs) {
        log.debug('config', 'cache version mismatch, clearing .jsc + local/');
        clearJscSync(dir);
        rmrf(joinPaths(dir, 'local'));
        writeText(vf, engine.versions.quickjs);
    }
}

// CLI template — all flags declared here

const CLI_TPL = {
    'cache-dir':      'string',
    'polyfill':       'string',
    'lock-dir':       'string',
    'memory-limit':   'string',
    'max-stack-size': 'string',
    'jsr-cache-ttl':  'number',
    'eval':           'string',
    'e':              'string',
    'silent':         'boolean',
    'no-http':        'boolean',
    'no-jsr':         'boolean',
    'no-node':        'boolean',
    'disable-cache':  'boolean',
    'cached-only':    'boolean',
    'no-oxc':         'boolean',
    'precache':       'boolean',
    'no-lock':        'boolean',
    'frozen':         'boolean',
    'ignore-scripts': 'boolean',
    'npm-mode': 'string',
    'help':           'boolean',
    'h':              'boolean',
    'version':        'boolean',
    'v':              'boolean',
    'jsx-pragma':     'string',
    'jsx-fragment-pragma': 'string',
} satisfies Record<string, 'string'|'boolean'|'number'>;

export function createConfig(userConfig: Partial<ConfigOptions> = {}): RuntimeConfig {
    const cli = parseArgs(os.args.slice(1), CLI_TPL);
    const cfg = { ...DEFAULTS, ...envConfig(), ...userConfig } as RuntimeConfig;

    if (cli['cache-dir'])     cfg.cacheDir     = cli['cache-dir'];
    if (cli['polyfill'])      cfg.polyfill      = cli['polyfill'];
    if (cli['eval'] || cli['e']) cfg.eval        = cli['eval'] || cli['e'];
    if (cli['lock-dir'])      cfg.lockDir       = cli['lock-dir'];
    if (cli['disable-cache']) cfg.enableCache  = false;
    if (cli['cached-only'])   cfg.cachedOnly   = true;
    if (cli['no-oxc']) cfg.enableOxc = false;
    if (cli['silent'])        cfg.silent        = true;
    if (cli['no-http'])       cfg.enableHttp    = false;
    if (cli['no-jsr'])        cfg.enableJsr     = false;
    if (cli['no-node'])       cfg.enableNode    = false;
    if (cli['no-lock'])       cfg.disableLock    = true;
    if (cli['frozen'])        cfg.frozen        = true;
    if (cli['ignore-scripts']) cfg.ignoreScripts = true;
    if (cli['npm-mode']) {
        const m = cli['npm-mode'];
        if (m === 'normal' || m === 'soft' || m === 'hard') cfg.nodeModulesMode = m;
        else log.warn('config', () => `invalid --npm-mode "${m}", ignoring`);
    }
    if (cli['memory-limit'] !== undefined)
        cfg.memoryLimit = parseSize(cli['memory-limit'] || env('CTS_MEMORY_LIMIT') || '1g');
    if (cli['max-stack-size'] !== undefined)
        cfg.maxStackSize = parseSize(cli['max-stack-size'] || env('CTS_MAX_STACK_SIZE') || '0');
    if (cli['jsr-cache-ttl'] !== undefined)
        cfg.jsrCacheTTL = cli['jsr-cache-ttl'] * 24 * 60 * 60 * 1000;
    if (cli['jsx-pragma']) cfg.jsxPragma = cli['jsx-pragma'];
    if (cli['jsx-fragment-pragma']) cfg.jsxFragmentPragma = cli['jsx-fragment-pragma'];

    cfg._ = cli._; cfg._args = cli._args; cfg._offset = cli._offset;

    if (!cfg.cacheDir) cfg.cacheDir = defaultCacheDir();
    verifyCacheDir(cfg.cacheDir);

    // Apply tier defaults unless explicitly overridden by CLI or env.
    const tier = getMemoryTier();
    if (cfg.memoryLimit === undefined) cfg.memoryLimit = TIER_MEM_LIMIT[tier] ?? DEFAULT_MEM_LIMIT;
    if (cfg.maxStackSize === undefined) cfg.maxStackSize = TIER_STACK_SIZE[tier] ?? DEFAULT_STACK_SIZE;
    engine.setMemoryLimit(cfg.memoryLimit);
    engine.setMaxStackSize(cfg.maxStackSize);
    cfg._cli = cli;  // keep raw CLI args for unknown flag warning
    return cfg;
}

// loadConfigFile — reads tsconfig / deno.json / package.json

export function loadConfigFile(dir: string): Partial<ConfigOptions> {
    const cfg: Partial<ConfigOptions> = {};
    const dirs: string[] = [dir];
    let cur = dir;
    while (cur !== '/' && cur !== '.') {
        const up = dirname(cur); if (up === cur) break;
        dirs.push(up); cur = up;
    }

    const readJson = (p: string): ConfigJson | null => {
        try { return safeParse(stripJsonc(engine.decodeString(fs.readFile(p)))); }
        catch { return null; }
    };

    let foundTsconfig = false, foundDeno = false, foundPkg = false;

    for (const d of dirs) {
        const tsP = joinPaths(d, 'tsconfig.json');
        if (!foundTsconfig && fs.exists(tsP)) {
            const ts = readJson(tsP);
            if (ts) {
                const paths = filterPathAliases(ts.compilerOptions?.paths);
                if (paths) cfg.pathAliases = paths;
                if (typeof ts.compilerOptions?.baseUrl === 'string') cfg.baseUrl = joinPaths(d, ts.compilerOptions.baseUrl);
                log.debug('config', () => `tsconfig: ${tsP}`);
                foundTsconfig = true;
            }
        }

        for (const name of ['deno.json', 'deno.jsonc']) {
            if (foundDeno) break;
            const p = joinPaths(d, name);
            if (!fs.exists(p)) continue;
            const dc = readJson(p);
            if (!dc) {
                foundDeno = true;
                break;
            }
            if (dc.imports) {
                cfg.importMap = { ...cfg.importMap, ...filterImports(dc.imports, d) };
            }
            cfg.importMapScopes = mergeImportMapScopes(
                cfg.importMapScopes,
                filterImportMapScopes(dc.scopes, d),
            );
            const paths = filterPathAliases(dc.compilerOptions?.paths);
            if (paths) cfg.pathAliases = { ...cfg.pathAliases, ...paths };
            if (typeof dc.importMap === 'string') {
                const mp = joinPaths(d, dc.importMap);
                if (fs.exists(mp)) {
                    const mj = readJson(mp);
                    if (mj?.imports) {
                        cfg.importMap = { ...cfg.importMap, ...filterImports(mj.imports, dirname(mp)) };
                    }
                    if (mj) {
                        cfg.importMapScopes = mergeImportMapScopes(
                            cfg.importMapScopes,
                            filterImportMapScopes(mj.scopes, dirname(mp)),
                        );
                    }
                }
            }
            log.debug('config', () => `${name}: ${p}`);
            foundDeno = true;
        }

        const pkgP = joinPaths(d, 'package.json');
        if (!foundPkg && fs.exists(pkgP)) {
            const pkg = readJson(pkgP);
            if (pkg) {
                if (pkg.imports && typeof pkg.imports === 'object') {
                    // package.json imports use reversed merge priority (package > deno)
                    cfg.importMap = { ...filterImports(pkg.imports, d), ...cfg.importMap };
                }
                const nmm = pkg.cts?.nodeModulesMode;
                if (nmm === 'normal' || nmm === 'soft' || nmm === 'hard') cfg.nodeModulesMode = nmm;
                foundPkg = true;
            }
        }

        if (foundTsconfig && foundDeno && foundPkg) break;
    }

    return cfg;
}

export { CLI_TPL };
