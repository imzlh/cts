// pkg.ts — package.json utilities with bounded caches

import type { PackageJson, ModuleFormat } from '../types';
import { dirname, extname, joinPaths, normalizePath, resolveFile, safeParse, LRU, log } from '../utils';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

// ---------------------------------------------------------------------------
// Cache capacities — tuned to typical project sizes without excess
// ---------------------------------------------------------------------------
//  pkgCache:      one entry per node_modules package → 512 covers very large projects
//  formatCache:   one per source file → 2048 is generous
//  formatDirCache:one per directory → 512 fine
//  exportsCache:  one per (pkgDir × subpath × cjs) triple → 1024

const _NO_PKG = Symbol('no.pkg');
const pkgCache      = new LRU<string, { pkg: PackageJson | typeof _NO_PKG; at: number }>(512);
const formatCache   = new LRU<string, ModuleFormat>(2048);
const formatDirCache = new LRU<string, ModuleFormat>(512);
const exportsCache = new LRU<string, ResolvedPath | null>(1024);

const PKG_TTL = 5 * 60 * 1000;

export function readPkg(dir: string): PackageJson | null {
    const hit = pkgCache.get(dir);
    if (hit && Date.now() - hit.at < PKG_TTL)
        return hit.pkg === _NO_PKG ? null : hit.pkg;
    const pkgPath = joinPaths(dir, 'package.json');
    if (!fs.exists(pkgPath)) { pkgCache.set(dir, { pkg: _NO_PKG, at: Date.now() }); return null; }
    try {
        const pkg = safeParse<PackageJson>(engine.decodeString(fs.readFile(pkgPath)));
        pkgCache.set(dir, { pkg, at: Date.now() });
        return pkg;
    } catch (e) {
        log.debug('pkg', () => `failed ${pkgPath}: ${e}`);
        pkgCache.set(dir, { pkg: _NO_PKG, at: Date.now() });
        return null;
    }
}

export function readPkgFresh(dir: string): PackageJson | null {
    const pkgPath = joinPaths(dir, 'package.json');
    if (!fs.exists(pkgPath)) return null;
    try { return safeParse<PackageJson>(engine.decodeString(fs.readFile(pkgPath))); }
    catch { return null; }
}

export function clearPkgCache(): void {
    pkgCache.clear(); formatCache.clear(); formatDirCache.clear(); exportsCache.clear();
}

// ---------------------------------------------------------------------------
// Bin field normalization
// ---------------------------------------------------------------------------

export function normalizeBinField(pkgName: string, bin: string | Record<string, string>): Record<string, string> {
    return typeof bin === 'string' ? { [pkgName]: bin } : bin;
}

export function getBinMap(pkg: PackageJson): Record<string, string> {
    return pkg.bin ? normalizeBinField(pkg.name || '', pkg.bin) : {};
}

// ---------------------------------------------------------------------------
// Format detection — two-level bounded cache
// ---------------------------------------------------------------------------

export function detectFormat(localPath: string): ModuleFormat {
    const hit = formatCache.get(localPath);
    if (hit) return hit;
    const result = _detectFormat(localPath);
    formatCache.set(localPath, result);
    return result;
}

function _detectFormat(localPath: string): ModuleFormat {
    const ext = extname(localPath);
    if (ext === '.mjs' || ext === '.mts' || ext === '.ts' || ext === '.tsx' || ext === '.jsx') return 'esm';
    if (ext === '.cjs' || ext === '.cts' || ext === '.node') return 'cjs';
    if (ext !== '.js') return 'esm';

    // Walk up directories, caching every intermediate dir to avoid re-traversal
    const startDir = dirname(localPath);
    let dir = startDir;
    const visited: string[] = []; // dirs we passed through without a result
    while (dir !== '/' && dir !== '.') {
        const cached = formatDirCache.get(dir);
        if (cached !== undefined) {
            // Back-fill visited dirs with the same result
            for (const v of visited) formatDirCache.set(v, cached);
            return cached;
        }
        visited.push(dir);
        // Deno projects default to ESM
        if (fs.exists(joinPaths(dir, 'deno.json')) || fs.exists(joinPaths(dir, 'deno.jsonc'))) {
            for (const v of visited) formatDirCache.set(v, 'esm');
            return 'esm';
        }
        const pkg = readPkg(dir);
        if (pkg) {
            const fmt: ModuleFormat = pkg.type === 'module' ? 'esm' : 'cjs';
            for (const v of visited) formatDirCache.set(v, fmt);
            return fmt;
        }
        const up = dirname(dir); if (up === dir) break; dir = up;
    }
    // No package.json found — default to CJS, cache all visited
    for (const v of visited) formatDirCache.set(v, 'cjs');
    return 'cjs';
}

// ---------------------------------------------------------------------------
// Resolution context
// ---------------------------------------------------------------------------

export interface ResolveCtx { pkgDir: string; pkg: PackageJson; forceCjs?: boolean }

export interface ResolvedPath {
    path: string;
    format: ModuleFormat;
}

export function createCtx(dir: string, opts: { forceCjs?: boolean } = {}): ResolveCtx | null {
    const pkg = readPkg(dir);
    return pkg ? { pkgDir: dir, pkg, ...opts } : null;
}

// ---------------------------------------------------------------------------
// Exports resolution — bounded cache
// ---------------------------------------------------------------------------

function exportsKey(ctx: ResolveCtx, sub: string): string {
    return `${ctx.pkgDir}\0${sub}\0${ctx.forceCjs ? '1' : '0'}`;
}

export function resolveExports(ctx: ResolveCtx, sub = '.'): ResolvedPath | null {
    const key = exportsKey(ctx, sub);
    const cached = exportsCache.get(key);
    if (cached !== undefined) return cached;
    const result = _resolveExports(ctx, sub);
    exportsCache.set(key, result);
    return result;
}

function conds(ctx: ResolveCtx): string[] {
    // Deliberately omit 'node': packages with divergent node/browser export
    // maps (e.g. vue, which bundles everything into a single CJS file under
    // 'node' but externalizes @vue/* packages under the browser/default ESM
    // build) would otherwise resolve to a different file — and a different
    // dependency graph — than bundlers like Vite/webpack pick, breaking
    // --npm-mode's materialized node_modules for those tools. import>default
    // for ESM, require>default for CJS. No 'module'/'browser' either — those
    // are bundler-only conventions neither runtime honors by default.
    return ctx.forceCjs ? ['require', 'default'] : ['import', 'default'];
}

function preferredFormatForPath(ctx: ResolveCtx, path: string, preferred?: ModuleFormat): ModuleFormat {
    const ext = extname(path);
    if (ext === '.cjs' || ext === '.cts' || ext === '.node') return 'cjs';
    if (ext === '.mjs' || ext === '.mts') return 'esm';
    if (preferred) return preferred;
    // The exports map landed on an ambiguous condition (e.g. a bare "default"
    // with no "import"/"require" branch). Some packages (vue, @vue/runtime-*)
    // point "exports" at the very same file their "module" field names — the
    // conventional (bundler-only) signal for "this is the package's ESM
    // build" — without ever setting "type": "module", since they expect a
    // bundler's own content-sniffing rather than Node's type/extension rules.
    // Same package, same file: honor that signal instead of guessing 'cjs'.
    if (ctx.pkg.module && resolvePath(ctx, ctx.pkg.module) === path) return 'esm';
    return detectFormat(path);
}

function resolvePath(ctx: ResolveCtx, p: string): string | null {
    if (!p) return null;
    if (p.includes('://') || p.startsWith('npm:') || p.startsWith('jsr:')) return p;
    try { return resolveFile(joinPaths(ctx.pkgDir, p.startsWith('./') ? p.slice(2) : p)); }
    catch { return null; }
}

function resolveTarget(ctx: ResolveCtx, t: unknown, rep?: string, preferred?: ModuleFormat): ResolvedPath | null {
    if (typeof t === 'string') {
        const path = resolvePath(ctx, rep !== undefined ? t.replace('*', rep) : t);
        return path ? { path, format: preferredFormatForPath(ctx, path, preferred) } : null;
    }
    if (Array.isArray(t)) {
        for (const e of t) { const r = resolveTarget(ctx, e, rep, preferred); if (r) return r; }
        return null;
    }
    if (t && typeof t === 'object') {
        for (const c of conds(ctx)) {
            if (!(c in t)) continue;
            const nextPreferred = c === 'import' ? 'esm'
                : c === 'require' ? 'cjs'
                : preferred;
            const r = resolveTarget(ctx, (t as any)[c], rep, nextPreferred);
            if (r) return r;
        }
    }
    return null;
}

function _resolveExports(ctx: ResolveCtx, sub: string): ResolvedPath | null {
    const { exports } = ctx.pkg;
    if (!exports) return null;
    if (typeof exports === 'string')
        return (sub === '.' || sub === './') ? resolveTarget(ctx, exports) : null;
    if (typeof exports !== 'object') return null;
    const map = exports as Record<string, unknown>;
    const direct = resolveTarget(ctx, map[sub]); if (direct) return direct;
    for (const [k, v] of Object.entries(map)) {
        if (!k.includes('*')) continue;
        const pre = k.slice(0, k.indexOf('*')), suf = k.slice(k.indexOf('*') + 1);
        if (sub.startsWith(pre) && sub.endsWith(suf)) {
            const rep = sub.slice(pre.length, suf.length ? -suf.length : undefined);
            const r = resolveTarget(ctx, v, rep); if (r) return r;
        }
    }
    return null;
}

/** Resolve a subpath import (package.json "imports" field, e.g. "#foo": "./path"). */
export function resolveImports(ctx: ResolveCtx, spec: string): ResolvedPath | null {
    const { imports } = ctx.pkg;
    if (!imports || typeof imports !== 'object') return null;
    const map = imports as Record<string, unknown>;
    // Direct match: "#foo" → "./path"
    const direct = resolveTarget(ctx, map[spec]);
    if (direct) return direct;
    // Wildcard match: "#foo/*" → "./bar/*"
    for (const [k, v] of Object.entries(map)) {
        if (!k.includes('*')) continue;
        const pre = k.slice(0, k.indexOf('*')), suf = k.slice(k.indexOf('*') + 1);
        if (spec.startsWith(pre) && spec.endsWith(suf)) {
            const rep = spec.slice(pre.length, suf.length ? -suf.length : undefined);
            const r = resolveTarget(ctx, v, rep);
            if (r) return r;
        }
    }
    return null;
}

export function resolveMain(ctx: ResolveCtx): ResolvedPath | null {
    const e = resolveExports(ctx, '.'); if (e) return e;
    // Some packages (e.g. devlop@1.1.0) use a "default" export condition
    // without a "." key — try it as a fallback
    if (ctx.pkg.exports && typeof ctx.pkg.exports === 'object') {
        const def = (ctx.pkg.exports as Record<string, unknown>)['default'];
        if (typeof def === 'string') {
            const resolved = resolveTarget(ctx, def);
            if (resolved) return resolved;
        }
    }
    if (!ctx.forceCjs && ctx.pkg.module) {
        const resolved = resolveTarget(ctx, ctx.pkg.module, undefined, 'esm');
        if (resolved) return resolved;
    }
    if (ctx.pkg.main) {
        const resolved = resolveTarget(ctx, ctx.pkg.main);
        if (resolved) return resolved;
    }
    const fallbacks = ctx.forceCjs
        ? ['index.js', 'index.json', 'index.node', 'index.mjs', 'index.cjs', 'index.ts']
        : ['index.js', 'index.mjs', 'index.cjs', 'index.ts'];
    for (const f of fallbacks) {
        const p = joinPaths(ctx.pkgDir, f);
        if (fs.exists(p)) return { path: p, format: detectFormat(p) };
    }
    return null;
}

export function resolveSubpath(ctx: ResolveCtx, sub: string): ResolvedPath | null {
    if (!sub || sub === '.' || sub === './') return resolveMain(ctx);
    const norm = sub.startsWith('./') ? sub : `./${sub}`;
    return resolveExports(ctx, norm) ?? (() => {
        try {
            const path = resolveFile(joinPaths(ctx.pkgDir, norm.slice(2)));
            return { path, format: detectFormat(path) };
        } catch { return null; }
    })();
}
