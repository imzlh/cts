// config.ts — configuration loading

import type { RuntimeConfig, ConfigOptions } from './types';
import { dirname, joinPaths } from './utils/path';
import { readText, writeText, ensureDir } from './utils/io';
import { stripJsonc, safeParse, parseArgs } from './utils/misc';
import { log } from './utils/log';
import { err, ErrorKind } from './errors';
import { os, fs, engine } from './utils/index';


// ---------------------------------------------------------------------------
// Defaults (only truly required fields)
// ---------------------------------------------------------------------------

const DEFAULTS = {
    enableHttp:  true,
    enableJsr:   true,
    enableNode:  true,
    silent:      false,
    jsrCacheTTL: 7 * 24 * 60 * 60 * 1000,
    disableCache: false,
    polyfill:    '',
    cacheDir:    '',
} as const;

// ---------------------------------------------------------------------------
// Memory size parser  "256MB" → bytes
// ---------------------------------------------------------------------------

export function parseSize(s: string | undefined): number | undefined {
    if (!s) return undefined;
    const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)?$/i);
    if (!m) throw err(ErrorKind.InvalidSpecifier, `Invalid size "${s}" — use e.g. 256MB, 1GB, 4MB`);
    const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3 };
    return Math.floor(parseFloat(m[1]!) * (units[(m[2] ?? 'B').toUpperCase()] ?? 1));
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function env(k: string): string | null { try { return os.getenv(k); } catch { return null; } }

function envConfig(): Partial<ConfigOptions> {
    const c: Partial<ConfigOptions> = {};
    const bool = (v: string | null) => v !== null ? v === 'true' : undefined;
    const E = 'CTS_';
    const v = (k: string) => env(E + k);
    const cacheDir = v('CACHE_DIR'); if (cacheDir) c.cacheDir = cacheDir;
    const dc  = bool(v('DISABLE_CACHE')); if (dc  !== undefined) c.disableCache = dc;
    const http = bool(v('ENABLE_HTTP')); if (http !== undefined) c.enableHttp = http;
    const jsr  = bool(v('ENABLE_JSR'));  if (jsr  !== undefined) c.enableJsr  = jsr;
    const node = bool(v('ENABLE_NODE')); if (node !== undefined) c.enableNode = node;
    const sil  = bool(v('SILENT'));      if (sil  !== undefined) c.silent = sil;
    const ml = v('MEMORY_LIMIT');   if (ml) c.memoryLimit  = parseSize(ml);
    const ms = v('MAX_STACK_SIZE'); if (ms) c.maxStackSize = parseSize(ms);
    const ttl = v('JSR_CACHE_TTL'); if (ttl) c.jsrCacheTTL = +ttl * 24 * 60 * 60 * 1000;
    return c;
}

function defaultCacheDir(): string {
    let home: string | null = null;
    try { home = os.homedir; } catch {}
    if (!home) home = env(os.uname().sysname.includes('Windows') ? 'USERPROFILE' : 'HOME') ?? '/root';
    return joinPaths(home, '.cts');
}

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

function clearJsc(dir: string): void {
    try {
        for (const e of fs.readdir(dir)) {
            const p = joinPaths(dir, e);
            try { if (fs.stat(p).isDirectory) clearJsc(p); else if (p.endsWith('.jsc')) fs.unlink(p); }
            catch {}
        }
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
        log.debug('config', 'cache version mismatch, clearing .jsc');
        clearJsc(dir);
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
    'silent':         'boolean',
    'no-http':        'boolean',
    'no-jsr':         'boolean',
    'no-node':        'boolean',
    'disable-cache':  'boolean',
    'precache':       'boolean',
    'no-lock':        'boolean',
    'frozen':         'boolean',
    'help':           'boolean',
    'h':              'boolean',
    'version':        'boolean',
    'v':              'boolean',
} satisfies Record<string, 'string'|'boolean'|'number'>;

function getEnv(name: string): string | null {
    try{
        return os.getenv(name);
    } catch {
        return null;
    }
}

export function createConfig(userConfig: Partial<ConfigOptions> = {}): RuntimeConfig {
    const cli = parseArgs(os.args.slice(1), CLI_TPL);
    const cfg = { ...DEFAULTS, ...envConfig(), ...userConfig } as RuntimeConfig;

    if (cli['cache-dir'])     cfg.cacheDir     = cli['cache-dir'] || getEnv('CTS_CACHE_DIR') || '';
    if (cli['polyfill'])      cfg.polyfill      = cli['polyfill'];
    if (cli['lock-dir'])      cfg.lockDir       = cli['lock-dir'] || getEnv('CTS_LOCK_DIR') || '';
    if (cli['disable-cache']) cfg.disableCache  = true;
    if (cli['silent'])        cfg.silent        = true;
    if (cli['no-http'])       cfg.enableHttp    = false;
    if (cli['no-jsr'])        cfg.enableJsr     = false;
    if (cli['no-node'])       cfg.enableNode    = false;
    if (cli['no-lock'])       cfg.noLock        = true;
    if (cli['frozen'])        cfg.frozen        = true;
    if (cli['memory-limit'] !== undefined)
        cfg.memoryLimit = parseSize(cli['memory-limit'] || getEnv('CTS_MEMORY_LIMIT') || '1g');
    if (cli['max-stack-size'] !== undefined)
        cfg.maxStackSize = parseSize(cli['max-stack-size'] || getEnv('CTS_MAX_STACK_SIZE') || '0');
    if (cli['jsr-cache-ttl'] !== undefined)
        cfg.jsrCacheTTL = (cli['jsr-cache-ttl'] as number) * 24 * 60 * 60 * 1000;

    cfg._ = cli._; cfg._args = cli._args; cfg._offset = cli._offset;

    if (!cfg.cacheDir) cfg.cacheDir = defaultCacheDir();
    verifyCacheDir(cfg.cacheDir);
    if (cfg.memoryLimit  !== undefined) engine.setMemoryLimit(cfg.memoryLimit);
    if (cfg.maxStackSize !== undefined) engine.setMaxStackSize(cfg.maxStackSize);
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
            if (dc.imports)                cfg.importMap  = { ...cfg.importMap,   ...dc.imports };
            if (dc.compilerOptions?.paths) cfg.pathAliases = { ...cfg.pathAliases, ...dc.compilerOptions.paths };
            if (typeof dc.importMap === 'string') {
                const mp = joinPaths(d, dc.importMap);
                if (fs.exists(mp)) {
                    const mj = readJson(mp);
                    if (mj?.imports) cfg.importMap = { ...cfg.importMap, ...mj.imports };
                }
            }
            log.debug('config', () => `${name}: ${p}`);
            foundDeno = true;
        }

        const pkgP = joinPaths(d, 'package.json');
        if (!foundPkg && fs.exists(pkgP)) {
            const pkg = readJson(pkgP);
            if (pkg) {
                if (pkg.imports && typeof pkg.imports === 'object')
                    cfg.importMap = { ...pkg.imports, ...cfg.importMap };
                foundPkg = true;
            }
        }

        if (foundTsconfig || foundDeno) break;
    }

    return cfg;
}

export { CLI_TPL };
