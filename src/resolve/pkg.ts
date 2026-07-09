// pkg.ts — package.json utilities with bounded caches

import type { FileKind, PackageJson, ModuleFormat } from '../types';
import { dirname, extname, joinPaths, normalizePath, resolveFile, safeParse, LRU, log } from '../utils';
import { err, ErrorKind } from '../errors';

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
const PACKAGE_SUBPATH_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.node', '.wasm'];

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
    try {
        return safeParse<PackageJson>(engine.decodeString(fs.readFile(pkgPath)));
    } catch {
        return null;
    }
}

export function clearPkgCache(): void {
    pkgCache.clear();
    formatCache.clear();
    formatDirCache.clear();
    exportsCache.clear();
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

export function detectPackageJsonFormat(localPath: string): ModuleFormat | null {
    const ext = extname(localPath);
    if (ext === '.cjs' || ext === '.cts' || ext === '.node') return 'cjs';
    if (ext === '.mjs' || ext === '.mts') return 'esm';
    if (ext !== '.js') return null;

    let dir = dirname(localPath);
    while (dir !== '/' && dir !== '.') {
        const pkg = readPkg(dir);
        if (pkg) return pkg.type === 'module' ? 'esm' : 'cjs';
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
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
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    // No package.json found — Deno-style local .js defaults to ESM. Packages
    // without a "type" field still stay CJS through the package.json branch.
    for (const v of visited) formatDirCache.set(v, 'esm');
    return 'esm';
}

// ---------------------------------------------------------------------------
// Resolution context
// ---------------------------------------------------------------------------

export interface ResolveCtx { pkgDir: string; pkg: PackageJson; forceCjs?: boolean; conditions?: string[] }

export interface ResolvedPath {
    path: string;
    format: ModuleFormat;
    fileKind?: FileKind;
}

export function createCtx(dir: string, opts: { forceCjs?: boolean; conditions?: string[] } = {}): ResolveCtx | null {
    const pkg = readPkg(dir);
    return pkg ? { pkgDir: dir, pkg, ...opts } : null;
}

// ---------------------------------------------------------------------------
// Exports resolution — bounded cache
// ---------------------------------------------------------------------------

function exportsKey(ctx: ResolveCtx, sub: string): string {
    return `${ctx.pkgDir}\0${sub}\0${ctx.forceCjs ? '1' : '0'}\0${ctx.conditions?.join('\0') ?? ''}`;
}

export function resolveExports(ctx: ResolveCtx, sub = '.'): ResolvedPath | null {
    const key = exportsKey(ctx, sub);
    const cached = exportsCache.get(key);
    if (cached !== undefined) return cached;
    const result = _resolveExports(ctx, sub);
    exportsCache.set(key, result);
    return result;
}

export function isPackageSubpathBlockedByExports(ctx: ResolveCtx, sub: string): boolean {
    if (!ctx.pkg.exports) return false;
    if (!sub || sub === '.' || sub === './') return resolveExports(ctx, '.') === null;
    const norm = sub.startsWith('./') ? sub : `./${sub}`;
    return resolveExports(ctx, norm) === null;
}

// True when "." resolves under neither ESM nor CJS conditions — a declaration-only
// package (e.g. modern @types/react, exports-mapped to "types" conditions only)
// rather than a real package whose exports just don't match the requested format.
export function isRootExportRuntimeless(ctx: ResolveCtx): boolean {
    return resolveExports({ ...ctx, forceCjs: true }, '.') === null
        && resolveExports({ ...ctx, forceCjs: false }, '.') === null;
}

export function packagePathNotExportedError(spec: string): Error {
    const error = err(ErrorKind.ModuleNotFound, `Package subpath is not exported: ${spec}`);
    Object.defineProperty(error, 'code', {
        value: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
        writable: true,
        enumerable: true,
        configurable: true,
    });
    return error;
}

export function packageImportNotDefinedError(spec: string, pkgDir: string, parent: string): Error {
    const error = err(ErrorKind.ModuleNotFound,
        `Package import specifier "${spec}" is not defined in package ${joinPaths(pkgDir, 'package.json')} imported from "${parent}"`);
    Object.defineProperty(error, 'code', {
        value: 'ERR_PACKAGE_IMPORT_NOT_DEFINED',
        writable: true,
        enumerable: true,
        configurable: true,
    });
    return error;
}

function conds(ctx: ResolveCtx): string[] {
    // Prefer explicit import/require branches, then Node runtime branches,
    // then default. Keeping import/require first avoids switching packages
    // that already publish a format-specific runtime entry.
    return ctx.forceCjs
        ? ['require', ...(ctx.conditions ?? []), 'node', 'default']
        : ['import', ...(ctx.conditions ?? []), 'node', 'default'];
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
    return detectPackageJsonFormat(path) ?? detectFormat(path);
}

function resolvePath(ctx: ResolveCtx, p: string): string | null {
    if (!p) return null;
    if (p.includes('://') || p.startsWith('npm:') || p.startsWith('jsr:')) return p;
    try {
        return resolvePackageSubpath(joinPaths(ctx.pkgDir, p.startsWith('./') ? p.slice(2) : p));
    } catch {
        return null;
    }
}

function tryPackageFile(path: string): string | null {
    try {
        const st = fs.stat(path);
        if (st.isFile) return path;
        if (st.isDirectory) return tryPackageIndex(path);
    } catch {}
    return null;
}

function tryPackageIndex(dir: string): string | null {
    const base = joinPaths(dir, 'index');
    for (const ext of PACKAGE_SUBPATH_EXTS) {
        try {
            const path = base + ext;
            if (fs.stat(path).isFile) return path;
        } catch {}
    }
    return null;
}

function resolvePackageSubpath(base: string): string {
    const exact = tryPackageFile(base);
    if (exact) return exact;
    for (const ext of PACKAGE_SUBPATH_EXTS) {
        const path = tryPackageFile(base + ext);
        if (path) return path;
    }
    return resolveFile(base, PACKAGE_SUBPATH_EXTS);
}

function resolveTarget(ctx: ResolveCtx, t: unknown, rep?: string, preferred?: ModuleFormat): ResolvedPath | null {
    if (typeof t === 'string') {
        const path = resolvePath(ctx, rep !== undefined ? t.replace('*', rep) : t);
        return path ? { path, format: preferredFormatForPath(ctx, path, preferred) } : null;
    }
    if (Array.isArray(t)) {
        for (const e of t) {
            const r = resolveTarget(ctx, e, rep, preferred);
            if (r) return r;
        }
        return null;
    }
    if (t && typeof t === 'object') {
        for (const c of conds(ctx)) {
            if (!(c in t)) continue;
            const nextPreferred = c === 'import' ? 'esm'
                : c === 'require' ? 'cjs'
                : preferred;
            const r = resolveTarget(ctx, Reflect.get(t, c), rep, nextPreferred);
            if (r) return r;
        }
    }
    return null;
}

// Longest-prefix-first, matching Node's exports/imports pattern specificity rule.
function matchWildcard(ctx: ResolveCtx, entries: [string, unknown][], sub: string): ResolvedPath | null {
    let best: { pre: string; suf: string; v: unknown } | null = null;
    for (const [k, v] of entries) {
        if (!k.includes('*')) continue;
        const pre = k.slice(0, k.indexOf('*')), suf = k.slice(k.indexOf('*') + 1);
        if (sub.startsWith(pre) && sub.endsWith(suf) && (!best || pre.length > best.pre.length)) best = { pre, suf, v };
    }
    if (!best) return null;
    const rep = sub.slice(best.pre.length, best.suf.length ? -best.suf.length : undefined);
    return resolveTarget(ctx, best.v, rep);
}

function _resolveExports(ctx: ResolveCtx, sub: string): ResolvedPath | null {
    const { exports } = ctx.pkg;
    if (!exports) return null;
    if (typeof exports === 'string')
        return (sub === '.' || sub === './') ? resolveTarget(ctx, exports) : null;
    if (typeof exports !== 'object') return null;
    const direct = resolveTarget(ctx, Reflect.get(exports, sub));
    if (direct) return direct;
    if (sub === '.' || sub === './') {
        const root = resolveTarget(ctx, exports);
        if (root) return root;
    }
    return matchWildcard(ctx, Object.entries(exports), sub);
}

/** Resolve a subpath import (package.json "imports" field, e.g. "#foo": "./path"). */
export function resolveImports(ctx: ResolveCtx, spec: string): ResolvedPath | null {
    const { imports } = ctx.pkg;
    if (!imports || typeof imports !== 'object') return null;
    const direct = resolveTarget(ctx, Reflect.get(imports, spec));
    if (direct) return direct;
    return matchWildcard(ctx, Object.entries(imports), spec);
}

export function resolveMain(ctx: ResolveCtx): ResolvedPath | null {
    const e = resolveExports(ctx, '.');
    if (e) return e;
    // Some packages (e.g. devlop@1.1.0) use a "default" export condition
    // without a "." key — try it as a fallback
    if (ctx.pkg.exports && typeof ctx.pkg.exports === 'object') {
        const def = Reflect.get(ctx.pkg.exports, 'default');
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
    const exported = resolveExports(ctx, norm);
    if (exported) return exported;
    const base = joinPaths(ctx.pkgDir, norm.slice(2));
    try {
        const path = resolvePackageSubpath(base);
        if (!extname(path)) return { path, format: 'cjs', fileKind: 'source' };
        return { path, format: detectFormat(path) };
    } catch {
        if (ctx.pkg.exports) return null;
    }

    const main = resolveMain(ctx);
    if (!main) return null;
    const mainDir = dirname(main.path);
    if (mainDir === ctx.pkgDir) return null;
    try {
        const path = resolvePackageSubpath(joinPaths(mainDir, norm.slice(2)));
        if (!extname(path)) return { path, format: 'cjs', fileKind: 'source' };
        return { path, format: detectFormat(path) };
    } catch {
        return null;
    }
}
