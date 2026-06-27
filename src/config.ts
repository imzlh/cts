// config.ts — configuration loading

import type { RuntimeConfig, ConfigOptions } from './types';
import { dirname, joinPaths, toPosixPath } from './utils/path';
import { readText, writeText, ensureDir } from './utils/io';
import { stripJsonc, safeParse, parseArgs } from './utils/misc';
import { log } from './utils/log';
import { err, ErrorKind } from './errors';
import { uname, isWindows } from './utils/index';
import { getMemoryTier } from './utils/tier';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const timers = import.meta.use('timers');

// ---------------------------------------------------------------------------
// Defaults (only truly required fields)
// ---------------------------------------------------------------------------

const DEFAULTS = {
    enableHttp:  true,
    enableJsr:   true,
    enableNode:  true,
    silent:      false,
    jsrCacheTTL: 7 * 24 * 60 * 60 * 1000,
    requestTimeout: 30000,
    enableCache: true,
    enableOxc: true,
    ignoreScripts: false,
    polyfill:    '',
    cacheDir:    '',
} as const;

// ---------------------------------------------------------------------------
// Tier-based runtime defaults (applied when no explicit CLI/env override)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Memory size parser  "256MB" → bytes
// ---------------------------------------------------------------------------

export function parseSize(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)?$/i);
    if (!m) throw err(ErrorKind.InvalidSpecifier, `Invalid size "${s}" — use e.g. 256MB, 1GB, 4MB`);
    const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
    return Math.floor(parseFloat(m[1]!) * (units[(m[2] ?? 'B').toUpperCase()] ?? 1));
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function env(k: string): string | null { try { return os.getenv(k); } catch { return null; } }

/** Filter import map entries: keep only string-valued, non-# entries. */
function filterImports(raw: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('#') && typeof v === 'string') out[k] = v;
    }
    return out;
}

function envConfig(): Partial<ConfigOptions> {
    const c: Partial<ConfigOptions> = {};
    const bool = (v: string | null) => v !== null ? v === 'true' : undefined;
    const E = 'CTS_';
    const v = (k: string) => env(E + k);
    const cacheDir = v('CACHE_DIR'); if (cacheDir) c.cacheDir = cacheDir;
    const dc  = bool(v('DISABLE_CACHE')); if (dc  !== undefined) c.enableCache = !dc;
    // New OXC env vars (preferred)
    const no  = bool(v('NO_OXC'));         if (no === true) c.enableOxc = false;
    const oxc = bool(v('ENABLE_OXC'));     if (oxc !== undefined) c.enableOxc = oxc;
    // Legacy SWC env vars — map to enableOxc for backward compat
    const ns  = bool(v('NO_SWC'));         if (ns === true) c.enableOxc = false;
    const swc = bool(v('ENABLE_SWC'));     if (swc !== undefined) c.enableOxc = swc;
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
    let home: string | null = null;
    try { home = os.homeDir; } catch {}
    if (!home) home = env(isWindows ? 'USERPROFILE' : 'HOME') ?? '/root';
    return joinPaths(toPosixPath(home), '.cts');
}

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

function clearJsc(dir: string): void {
    // Delete .jsc files in a background timer so we don't block startup.
    timers.setTimeout(() => { try { clearJscSync(dir); } catch {} }, 0);
}

function clearJscSync(dir: string): void {
    try {
        for (const e of fs.readdir(dir)) {
            const p = joinPaths(dir, e);
            try { if (fs.stat(p).isDirectory) clearJscSync(p); else if (p.endsWith('.jsc')) fs.unlink(p); }
            catch {}
        }
    } catch {}
}

/** Remove a directory and all contents (used for {cacheDir}/local/ cleanup). */
function rmrf(dir: string): void {
    try {
        for (const e of fs.readdir(dir)) {
            const p = joinPaths(dir, e);
            try {
                if (fs.stat(p).isDirectory) rmrf(p);
                else fs.unlink(p);
            } catch {}
        }
        try { fs.rmdir(dir); } catch {}
    } catch {}
}

function verifyCacheDir(dir: string): void {
    if (!fs.exists(dir)) {
        ensureDir(dir);
        writeText(joinPaths(dir, 'version'), engine.versions.quickjs);
        return;
    }
    const vf = joinPaths(dir, 'version');
    let stored = '';
    try { stored = readText(vf); } catch {}
    if (stored !== engine.versions.quickjs) {
        log.debug('config', 'cache version mismatch, clearing .jsc + local/');
        clearJscSync(dir);
        rmrf(joinPaths(dir, 'local'));
        writeText(vf, engine.versions.quickjs);
    }
}

// ---------------------------------------------------------------------------
// CLI template — all flags declared here
// ---------------------------------------------------------------------------

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
    'no-oxc':         'boolean',
    'no-swc':         'boolean',
    'precache':       'boolean',
    'no-lock':        'boolean',
    'frozen':         'boolean',
    'ignore-scripts': 'boolean',
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

    if (cli['cache-dir'])     cfg.cacheDir     = cli['cache-dir'] || env('CTS_CACHE_DIR') || '';
    if (cli['polyfill'])      cfg.polyfill      = cli['polyfill'];
    if (cli['eval'] || cli['e']) cfg.eval        = (cli['eval'] || cli['e']) as string;
    if (cli['lock-dir'])      cfg.lockDir       = cli['lock-dir'] || env('CTS_LOCK_DIR') || '';
    if (cli['disable-cache']) cfg.enableCache  = false;
    if (cli['no-oxc'] || cli['no-swc']) cfg.enableOxc = false;
    if (cli['silent'])        cfg.silent        = true;
    if (cli['no-http'])       cfg.enableHttp    = false;
    if (cli['no-jsr'])        cfg.enableJsr     = false;
    if (cli['no-node'])       cfg.enableNode    = false;
    if (cli['no-lock'])       cfg.disableLock    = true;
    if (cli['frozen'])        cfg.frozen        = true;
    if (cli['ignore-scripts']) cfg.ignoreScripts = true;
    if (cli['memory-limit'] !== undefined)
        cfg.memoryLimit = parseSize(cli['memory-limit'] || env('CTS_MEMORY_LIMIT') || '1g');
    if (cli['max-stack-size'] !== undefined)
        cfg.maxStackSize = parseSize(cli['max-stack-size'] || env('CTS_MAX_STACK_SIZE') || '0');
    if (cli['jsr-cache-ttl'] !== undefined)
        cfg.jsrCacheTTL = (cli['jsr-cache-ttl'] as number) * 24 * 60 * 60 * 1000;
    if (cli['jsx-pragma']) cfg.jsxPragma = cli['jsx-pragma'];
    if (cli['jsx-fragment-pragma']) cfg.jsxFragmentPragma = cli['jsx-fragment-pragma'];

    cfg._ = cli._; cfg._args = cli._args; cfg._offset = cli._offset;

    if (!cfg.cacheDir) cfg.cacheDir = defaultCacheDir();
    verifyCacheDir(cfg.cacheDir);

    // Apply tier defaults unless explicitly overridden by CLI or env.
    const tier = getMemoryTier();
    if (cfg.memoryLimit === undefined) cfg.memoryLimit = TIER_MEM_LIMIT[tier] ?? TIER_MEM_LIMIT['normal']!;
    if (cfg.maxStackSize === undefined) cfg.maxStackSize = TIER_STACK_SIZE[tier] ?? TIER_STACK_SIZE['normal']!;
    engine.setMemoryLimit(cfg.memoryLimit);
    engine.setMaxStackSize(cfg.maxStackSize);
    (cfg as any)._cli = cli;  // keep raw CLI args for unknown flag warning
    return cfg;
}

// ---------------------------------------------------------------------------
// loadConfigFile — reads tsconfig / deno.json / package.json
// ---------------------------------------------------------------------------

export function loadConfigFile(dir: string): Partial<ConfigOptions> {
    const cfg: Partial<ConfigOptions> = {};
    const dirs: string[] = [dir];
    let cur = dir;
    while (cur !== '/' && cur !== '.') {
        const up = dirname(cur); if (up === cur) break;
        dirs.push(up); cur = up;
    }

    const readJson = (p: string): Record<string, any> | null => {
        try { return safeParse(stripJsonc(engine.decodeString(fs.readFile(p)))); }
        catch { return null; }
    };

    for (const d of dirs) {
        let foundTsconfig = false, foundDeno = false, foundPkg = false;

        const tsP = joinPaths(d, 'tsconfig.json');
        if (!foundTsconfig && fs.exists(tsP)) {
            const ts = readJson(tsP);
            if (ts) {
                if (ts.compilerOptions?.paths)   cfg.pathAliases = ts.compilerOptions.paths;
                if (ts.compilerOptions?.baseUrl) cfg.baseUrl = joinPaths(d, ts.compilerOptions.baseUrl);
                log.debug('config', () => `tsconfig: ${tsP}`);
                foundTsconfig = true;
            }
        }

        for (const name of ['deno.json', 'deno.jsonc']) {
            if (foundDeno) break;
            const p = joinPaths(d, name);
            if (!fs.exists(p)) continue;
            const dc = readJson(p); if (!dc) { foundDeno = true; break; }
            if (dc.imports) {
                cfg.importMap = { ...cfg.importMap, ...filterImports(dc.imports as Record<string, unknown>) };
            }
            if (dc.compilerOptions?.paths) cfg.pathAliases = { ...cfg.pathAliases, ...dc.compilerOptions.paths };
            if (typeof dc.importMap === 'string') {
                const mp = joinPaths(d, dc.importMap);
                if (fs.exists(mp)) {
                    const mj = readJson(mp);
                    if (mj?.imports) {
                        cfg.importMap = { ...cfg.importMap, ...filterImports(mj.imports as Record<string, unknown>) };
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
                    cfg.importMap = { ...filterImports(pkg.imports as Record<string, unknown>), ...cfg.importMap };
                }
                foundPkg = true;
            }
        }

        if (foundTsconfig || foundDeno) break;
    }

    return cfg;
}

export { CLI_TPL };
