import type { FileKind, PackageJson, ModuleFormat } from '../types';
import { dirname, extname, joinPaths, normalizePath, toPosixPath, resolveFile, safeParse, LRU, log, isValidNpmPackageName } from '../utils';
import { err, ErrorKind } from '../errors';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

// pkg 512 / format 2048 / formatDir 512 / exports 1024

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

/** npm: string `bin` → command is unscoped leaf (`@babel/parser` → `parser`). */
export function normalizeBinField(pkgName: string, bin: string | Record<string, string>): Record<string, string> {
    if (typeof bin !== 'string') return bin;
    if (!isValidNpmPackageName(pkgName)) return {};
    const slash = pkgName.lastIndexOf('/');
    const cmd = slash === -1 ? pkgName : pkgName.slice(slash + 1);
    return { [cmd || pkgName]: bin };
}

/**
 * Bin map for sites that turn the bin KEY into a filesystem path — the
 * node_modules/.bin symlink writer and the lock bin index. The key filter is
 * load-bearing there: joinPaths(binDir, '..\\..\\evil') normalises to
 * binDir/../../evil and escapes, and that call site has no pathWithin() check.
 * Use getLookupBinMap() for read-only key lookups instead of loosening this.
 */
export function getBinMap(pkg: PackageJson): Record<string, string> {
    return buildBinMap(pkg, isSafeBinName);
}

/**
 * Bin map for read-only lookups (`npm:pkg@ver/<bin>` resolution and `explain`).
 * A bin key is a name to match against the manifest, not a path: npm allows
 * keys such as `\foo"` (the @denotest/special-chars-in-bin-name fixture), which
 * are legal filenames on POSIX and carry no traversal meaning for a lookup.
 * Containment is still enforced on the bin TARGET by resolvePackageBinPath(),
 * so a hostile key can only ever select a value that stays inside the package.
 * '/' stays rejected because in a specifier it means a subpath, not a bin.
 */
export function getLookupBinMap(pkg: PackageJson): Record<string, string> {
    return buildBinMap(pkg, isLookupBinName);
}

function buildBinMap(pkg: PackageJson, nameOk: (name: string) => boolean): Record<string, string> {
    const raw = pkg.bin ? normalizeBinField(pkg.name || '', pkg.bin) : {};
    const out: Record<string, string> = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [name, target] of Object.entries(raw)) {
        if (nameOk(name) && typeof target === 'string' && isSafeBinTarget(target)) out[name] = target;
    }
    return out;
}

function isSafeBinName(name: string): boolean {
    return isLookupBinName(name) && !name.includes('\\') && !name.includes(':');
}

function isLookupBinName(name: string): boolean {
    return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

function normalizeBinTarget(target: string): string | null {
    const normalized = toPosixPath(target);
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || /^[a-z]:[\\/]/i.test(normalized)) {
        return null;
    }
    const path = normalizePath(normalized);
    if (path === '.' || path === '..' || path.startsWith('../') || /^[a-z]:[\\/]/i.test(path)) return null;
    return path;
}

function isSafeBinTarget(target: string): boolean {
    return normalizeBinTarget(target) !== null;
}

function pathWithin(root: string, candidate: string): boolean {
    const base = normalizePath(toPosixPath(root));
    const path = normalizePath(toPosixPath(candidate));
    const prefix = base.endsWith('/') ? base : `${base}/`;
    return path === base || path.startsWith(prefix);
}

export function resolvePackageBinPath(pkgDir: string, relPath: string): string | null {
    const relative = normalizeBinTarget(relPath);
    if (!relative) return null;
    const root = normalizePath(toPosixPath(pkgDir));
    const candidate = normalizePath(joinPaths(root, relative));
    if (!pathWithin(root, candidate)) return null;
    try {
        if (!fs.stat(candidate).isFile) return null;
        const realRoot = normalizePath(toPosixPath(fs.realpath(root)));
        const realCandidate = normalizePath(toPosixPath(fs.realpath(candidate)));
        return pathWithin(realRoot, realCandidate) ? candidate : null;
    } catch {
        return null;
    }
}

// Format detection — two-level bounded cache

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

export interface ResolveCtx { pkgDir: string; pkg: PackageJson; forceCjs?: boolean; conditions?: string[] }

export interface ResolvedPath {
    path: string;
    format: ModuleFormat;
    fileKind?: FileKind;
    externalSpecifier?: boolean;
    /** URL query/fragment kept out of the on-disk path. */
    specifierSuffix?: string;
}

type TargetMode = 'legacy' | 'exports' | 'imports';
type TargetOutcome =
    | { status: 'resolved'; value: ResolvedPath }
    | { status: 'blocked' }
    | { status: 'unmatched' };

const UNMATCHED: TargetOutcome = { status: 'unmatched' };
const BLOCKED: TargetOutcome = { status: 'blocked' };

export function createCtx(dir: string, opts: { forceCjs?: boolean; conditions?: string[] } = {}): ResolveCtx | null {
    const pkg = readPkg(dir);
    return pkg ? { pkgDir: dir, pkg, ...opts } : null;
}

// Exports resolution — bounded cache

function exportsKey(ctx: ResolveCtx, sub: string): string {
    return `${ctx.pkgDir}\0${sub}\0${ctx.forceCjs ? '1' : '0'}\0${ctx.conditions?.join('\0') ?? ''}`;
}

export function resolveExports(ctx: ResolveCtx, sub = '.'): ResolvedPath | null {
    const normalizedSub = sub === './' ? '.' : sub;
    const key = exportsKey(ctx, normalizedSub);
    const cached = exportsCache.get(key);
    if (cached !== undefined) return cached;
    const result = _resolveExports(ctx, normalizedSub);
    exportsCache.set(key, result);
    return result;
}

export function isPackageSubpathBlockedByExports(ctx: ResolveCtx, sub: string): boolean {
    if (ctx.pkg.exports === undefined) return false;
    if (!sub || sub === '.' || sub === './') return resolveExports(ctx, '.') === null;
    const norm = sub.startsWith('./') ? sub : `./${sub}`;
    return resolveExports(ctx, norm) === null;
}

// "." unresolvable under import/require → declaration-only package (e.g. @types/*).
export function isRootExportRuntimeless(ctx: ResolveCtx): boolean {
    const exports = ctx.pkg.exports;
    if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return false;
    const root = Object.prototype.hasOwnProperty.call(exports, '.') ? Reflect.get(exports, '.') : exports;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
    const keys = Object.keys(root);
    return keys.length > 0 && keys.every(key => key === 'types' || key.startsWith('types@'));
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

function codedError(kind: ErrorKind, code: string, message: string): Error {
    const error = err(kind, message);
    Object.defineProperty(error, 'code', {
        value: code,
        writable: true,
        enumerable: true,
        configurable: true,
    });
    return error;
}

function invalidPackageTargetError(ctx: ResolveCtx, target: unknown): Error {
    return codedError(ErrorKind.InvalidSpecifier, 'ERR_INVALID_PACKAGE_TARGET',
        `Invalid package target ${JSON.stringify(target)} in ${joinPaths(ctx.pkgDir, 'package.json')}`);
}

function invalidPackageConfigError(ctx: ResolveCtx, message: string): Error {
    return codedError(ErrorKind.InvalidSpecifier, 'ERR_INVALID_PACKAGE_CONFIG',
        `Invalid package config ${joinPaths(ctx.pkgDir, 'package.json')}: ${message}`);
}

function invalidModuleSpecifierError(spec: string): Error {
    return codedError(ErrorKind.InvalidSpecifier, 'ERR_INVALID_MODULE_SPECIFIER',
        `Invalid module specifier "${spec}"`);
}

function conditionSet(ctx: ResolveCtx): Set<string> {
    // Condition object order is authoritative. This set only answers whether
    // a key is active; iteration happens over the package's own key order.
    return new Set([
        ctx.forceCjs ? 'require' : 'import',
        ...(ctx.conditions ?? []),
        'node',
        'node-addons',
        'module-sync',
        'default',
    ]);
}

function preferredFormatForPath(ctx: ResolveCtx, path: string, preferred?: ModuleFormat): ModuleFormat {
    const ext = extname(path);
    if (ext === '.cjs' || ext === '.cts' || ext === '.node') return 'cjs';
    if (ext === '.mjs' || ext === '.mts') return 'esm';
    if (!ext) return ctx.pkg.type === 'module' ? 'esm' : 'cjs';
    if (preferred) return preferred;
    // Ambiguous exports target same as "module" field → treat as ESM.
    if (ctx.pkg.module && resolveLegacyPath(ctx, ctx.pkg.module) === path) return 'esm';
    return detectPackageJsonFormat(path) ?? detectFormat(path);
}

function packageLocalPath(ctx: ResolveCtx, path: string): string | null {
    const relative = path.startsWith('./') ? path.slice(2) : path;
    if (relative.startsWith('/') || relative.includes('\0') || /^[a-z]:[\\/]/i.test(relative)) return null;
    const root = normalizePath(ctx.pkgDir);
    const candidate = normalizePath(joinPaths(root, relative));
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return candidate === root || candidate.startsWith(prefix) ? candidate : null;
}

function resolveLegacyPath(ctx: ResolveCtx, p: string): string | null {
    if (!p) return null;
    if (p.includes('://') || p.startsWith('npm:') || p.startsWith('jsr:')) return p;
    const base = packageLocalPath(ctx, p);
    if (!base) return null;
    try {
        return resolvePackageSubpath(base);
    } catch {
        return null;
    }
}

function packageTargetPath(ctx: ResolveCtx, target: string): { path: string; suffix: string } {
    if (!target.startsWith('./') || target.includes('\\') || target.includes('\0')) {
        throw invalidPackageTargetError(ctx, target);
    }
    const query = target.indexOf('?');
    const hash = target.indexOf('#');
    const cut = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash);
    const pathTarget = cut === -1 ? target : target.slice(0, cut);
    const suffix = cut === -1 ? '' : target.slice(cut);
    if (/%2f|%5c/i.test(pathTarget)) throw invalidModuleSpecifierError(target);
    const segments = pathTarget.slice(2).split('/');
    for (const segment of segments) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            throw invalidModuleSpecifierError(target);
        }
        const lower = decoded.toLowerCase();
        if (decoded === '.' || decoded === '..' || lower === 'node_modules') {
            throw invalidPackageTargetError(ctx, target);
        }
    }
    return { path: normalizePath(joinPaths(ctx.pkgDir, pathTarget.slice(2))), suffix };
}

function externalImportTarget(ctx: ResolveCtx, target: string): ResolvedPath {
    if (!target || target.startsWith('.') || target.startsWith('/') || target.includes('\\') ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)) {
        throw invalidPackageTargetError(ctx, target);
    }
    return { path: target, format: 'esm', externalSpecifier: true };
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

function isRegularFile(path: string): boolean {
    try {
        return fs.stat(path).isFile;
    } catch {
        return false;
    }
}

function resolvePackageSubpath(base: string, ctx?: ResolveCtx): string {
    // Node CJS order: exact file → base+ext → directory package.json "main" →
    // directory index. `foo.js` must win over `foo/index.js`, so the directory
    // probe runs after extension probing; `foo/package.json` main wins over
    // `foo/index.js` (LOAD_PACKAGE_MAIN precedes LOAD_INDEX).
    if (isRegularFile(base)) return base;
    for (const ext of PACKAGE_SUBPATH_EXTS) {
        if (isRegularFile(base + ext)) return base + ext;
    }
    if (ctx) {
        const nested = resolveNestedPackageDir(ctx, base);
        if (nested) return nested.path;
    }
    const dirIndex = tryPackageFile(base);
    if (dirIndex) return dirIndex;
    for (const ext of PACKAGE_SUBPATH_EXTS) {
        const path = tryPackageFile(base + ext);
        if (path) return path;
    }
    return resolveFile(base, PACKAGE_SUBPATH_EXTS);
}

function resolveTargetOutcome(
    ctx: ResolveCtx,
    t: unknown,
    rep?: string,
    preferred?: ModuleFormat,
    mode: TargetMode = 'legacy',
): TargetOutcome {
    if (t === null) return BLOCKED;
    if (typeof t === 'string') {
        const target = rep !== undefined ? t.replaceAll('*', rep) : t;
        if (mode === 'imports' && !target.startsWith('./')) {
            return { status: 'resolved', value: externalImportTarget(ctx, target) };
        }
        const resolvedTarget = mode === 'legacy'
            ? (() => {
                const path = resolveLegacyPath(ctx, target);
                return path ? { path, suffix: '' } : null;
            })()
            : packageTargetPath(ctx, target);
        return resolvedTarget
            ? {
                status: 'resolved',
                value: {
                    path: resolvedTarget.path,
                    format: preferredFormatForPath(ctx, resolvedTarget.path, preferred),
                    fileKind: extname(resolvedTarget.path) ? undefined : 'source',
                    specifierSuffix: resolvedTarget.suffix || undefined,
                },
            }
            : UNMATCHED;
    }
    if (Array.isArray(t)) {
        let lastInvalid: Error | null = null;
        for (const e of t) {
            let r: TargetOutcome;
            try {
                r = resolveTargetOutcome(ctx, e, rep, preferred, mode);
            } catch (error) {
                if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ERR_INVALID_PACKAGE_TARGET') throw error;
                lastInvalid = error;
                continue;
            }
            if (r.status === 'resolved') return r;
            if (r.status === 'blocked') lastInvalid = null;
        }
        if (lastInvalid) throw lastInvalid;
        return UNMATCHED;
    }
    if (t && typeof t === 'object') {
        for (const key of Object.keys(t)) {
            if (/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffff_ffff) {
                throw invalidPackageConfigError(ctx, `numeric condition key "${key}" is not allowed`);
            }
        }
        const active = conditionSet(ctx);
        for (const [c, value] of Object.entries(t)) {
            if (!active.has(c)) continue;
            const r = resolveTargetOutcome(ctx, value, rep, preferred, mode);
            if (r.status !== 'unmatched') return r;
        }
        return UNMATCHED;
    }
    if (t === undefined) return UNMATCHED;
    throw invalidPackageTargetError(ctx, t);
}

function resolveTarget(
    ctx: ResolveCtx,
    t: unknown,
    rep?: string,
    preferred?: ModuleFormat,
    mode: TargetMode = 'legacy',
): ResolvedPath | null {
    const outcome = resolveTargetOutcome(ctx, t, rep, preferred, mode);
    return outcome.status === 'resolved' ? outcome.value : null;
}

// Longest-prefix-first, matching Node's exports/imports pattern specificity rule.
function matchWildcardOutcome(ctx: ResolveCtx, entries: [string, unknown][], sub: string, mode: TargetMode): TargetOutcome {
    let best: { pre: string; suf: string; v: unknown; keyLength: number } | null = null;
    for (const [k, v] of entries) {
        if (!k.includes('*')) continue;
        const pre = k.slice(0, k.indexOf('*')), suf = k.slice(k.indexOf('*') + 1);
        if (k.lastIndexOf('*') !== k.indexOf('*') || sub.length < k.length) continue;
        if (sub.startsWith(pre) && sub.endsWith(suf) &&
            (!best || pre.length > best.pre.length || (pre.length === best.pre.length && k.length > best.keyLength))) {
            best = { pre, suf, v, keyLength: k.length };
        }
    }
    if (!best) return UNMATCHED;
    const rep = sub.slice(best.pre.length, best.suf.length ? -best.suf.length : undefined);
    return resolveTargetOutcome(ctx, best.v, rep, undefined, mode);
}

function matchWildcard(ctx: ResolveCtx, entries: [string, unknown][], sub: string, mode: TargetMode): ResolvedPath | null {
    const outcome = matchWildcardOutcome(ctx, entries, sub, mode);
    return outcome.status === 'resolved' ? outcome.value : null;
}

function exportsObjectKind(ctx: ResolveCtx, exports: Record<string, unknown>): 'subpath' | 'conditions' {
    let hasSubpath = false;
    let hasCondition = false;
    for (const key of Object.keys(exports)) {
        if (key.startsWith('.')) hasSubpath = true;
        else hasCondition = true;
    }
    if (hasSubpath && hasCondition) {
        throw invalidPackageConfigError(ctx, '"exports" cannot mix subpath and condition keys');
    }
    return hasSubpath ? 'subpath' : 'conditions';
}

function _resolveExports(ctx: ResolveCtx, sub: string): ResolvedPath | null {
    const { exports } = ctx.pkg;
    if (exports === undefined || exports === null) return null;
    if (typeof exports === 'string')
        return sub === '.' ? resolveTarget(ctx, exports, undefined, undefined, 'exports') : null;
    if (typeof exports !== 'object' || Array.isArray(exports)) {
        return sub === '.' ? resolveTarget(ctx, exports, undefined, undefined, 'exports') : null;
    }
    const kind = exportsObjectKind(ctx, exports);
    if (kind === 'conditions') {
        return sub === '.' ? resolveTarget(ctx, exports, undefined, undefined, 'exports') : null;
    }
    if (Object.prototype.hasOwnProperty.call(exports, sub) && !sub.includes('*') && !sub.endsWith('/')) {
        return resolveTarget(ctx, Reflect.get(exports, sub), undefined, undefined, 'exports');
    }
    return matchWildcard(ctx, Object.entries(exports), sub, 'exports');
}

/** Resolve a subpath import (package.json "imports" field, e.g. "#foo": "./path"). */
export function resolveImports(ctx: ResolveCtx, spec: string): ResolvedPath | null {
    if (!spec.startsWith('#') || spec === '#' || spec.endsWith('/')) {
        throw invalidModuleSpecifierError(spec);
    }
    const { imports } = ctx.pkg;
    if (!imports) return null;
    if (typeof imports !== 'object' || Array.isArray(imports)) {
        throw invalidPackageConfigError(ctx, '"imports" must be an object');
    }
    if (Object.prototype.hasOwnProperty.call(imports, spec) && !spec.includes('*')) {
        return resolveTarget(ctx, Reflect.get(imports, spec), undefined, undefined, 'imports');
    }
    return matchWildcard(ctx, Object.entries(imports), spec, 'imports');
}

export function resolveMain(ctx: ResolveCtx): ResolvedPath | null {
    if (ctx.pkg.exports !== undefined) return resolveExports(ctx, '.');
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

/** Nested folder package.json (e.g. constants/package.json → main). */
function resolveNestedPackageDir(ctx: ResolveCtx, dir: string): ResolvedPath | null {
    try {
        if (!fs.stat(dir).isDirectory) return null;
    } catch {
        return null;
    }
    const nested = createCtx(dir, { forceCjs: ctx.forceCjs, conditions: ctx.conditions });
    return nested ? resolveMain(nested) : null;
}

export function resolveSubpath(ctx: ResolveCtx, sub: string): ResolvedPath | null {
    if (!sub || sub === '.' || sub === './') return resolveMain(ctx);
    const norm = sub.startsWith('./') ? sub : `./${sub}`;
    if (ctx.pkg.exports !== undefined) return resolveExports(ctx, norm);
    const base = packageLocalPath(ctx, norm);
    if (!base) return null;
    // ESM package subpaths are exact. Keep the nested package.json exception,
    // but do not add source extensions or directory indexes here.
    if (!ctx.forceCjs) {
        try {
            if (fs.stat(base).isFile) {
                if (!extname(base)) {
                    return { path: base, format: preferredFormatForPath(ctx, base), fileKind: 'source' };
                }
                return { path: base, format: detectFormat(base) };
            }
        } catch {}
        // react-remove-scroll-bar/constants etc. — folder package, no exports field
        if (!ctx.pkg.exports) {
            const nested = resolveNestedPackageDir(ctx, base);
            if (nested) return nested;
        }
        return null;
    }
    try {
        const path = resolvePackageSubpath(base, ctx);
        if (!extname(path)) {
            return { path, format: preferredFormatForPath(ctx, path), fileKind: 'source' };
        }
        return { path, format: detectFormat(path) };
    } catch {
        if (ctx.pkg.exports) return null;
    }

    const main = resolveMain(ctx);
    if (!main) return null;
    const mainDir = dirname(main.path);
    if (mainDir === ctx.pkgDir) return null;
    try {
        const path = resolvePackageSubpath(joinPaths(mainDir, norm.slice(2)), ctx);
        if (!extname(path)) {
            return { path, format: preferredFormatForPath(ctx, path), fileKind: 'source' };
        }
        return { path, format: detectFormat(path) };
    } catch {
        return null;
    }
}
