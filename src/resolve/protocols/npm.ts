// protocol/npm.ts - npm registry handler

import type { RuntimeConfig, ModuleInfo, ModuleFormat } from '../../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { StepType, type Flow, type TarFile, type ProgressCallback } from '../../flow';
import { joinPaths, dirname, basename, normalizePath, toPosixPath, pathRoot, cwd } from '../../utils/path';
import { readText, resolveFile } from '../../utils/io';
declare const URL: any;
import { matchLatestVersion, compareVersions, safeParse, fmtBytes } from '../../utils/misc';
import { detectFormat, readPkg, createCtx, resolveSubpath, resolveImports, getBinMap, type ResolvedPath } from '../pkg';
import { err, ErrorKind } from '../../errors';
import { log } from '../../utils/log';
import { isatty } from '../../utils/progress';
import { uname, isWindows } from '../../utils/index';
import { findLocalBin } from '../../utils/bin';
import { version } from '../../../package.json';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

interface NpmConfig {
    registry: string;
    authToken?: string;
    scopeRegistries: Record<string, string>;
    scopeTokens: Record<string, string>;
}

function loadNpmConfig(): NpmConfig {
    const cfg: NpmConfig = { registry: 'https://registry.npmjs.org', scopeRegistries: {}, scopeTokens: {} };
    const parse = (txt: string, override: boolean) => {
        for (const raw of txt.split('\n')) {
            const line = raw.trim();
            if (!line || line[0] === '#' || line[0] === ';') continue;
            const eq = line.indexOf('='); if (eq === -1) continue;
            const k = line.slice(0, eq).trim();
            const v = line.slice(eq + 1).trim().replace(/\s+[#;].*$/, '').replace(/^['"]|['"]$/g, '');
            if (k === 'registry' && (override || cfg.registry === 'https://registry.npmjs.org'))
                cfg.registry = v.replace(/\/$/, '');
            else if ((k === '_authToken' || k === 'authToken') && (override || !cfg.authToken))
                cfg.authToken = v;
            else if (k.startsWith('@') && k.endsWith(':registry'))
                cfg.scopeRegistries[k.slice(0, -9)] ??= v.replace(/\/$/, '');
            else if (k.includes(':_authToken') || k.includes(':authToken'))
                cfg.scopeTokens[k] ??= v;
        }
    };
    try { const p = joinPaths(cwd(), '.npmrc'); if (fs.exists(p)) parse(readText(p), true); } catch {}
    try { const p = joinPaths(toPosixPath(String(os.homeDir ?? '/root')), '.npmrc'); if (fs.exists(p)) parse(readText(p), false); } catch {}
    try { const r = os.getenv?.('NPM_CONFIG_REGISTRY'); if (r) cfg.registry = r.replace(/\/$/, ''); } catch {}
    try { const t = os.getenv?.('NPM_TOKEN') ?? os.getenv?.('NODE_AUTH_TOKEN'); if (t) cfg.authToken = t; } catch {}
    return cfg;
}

interface ParsedNpmSpec { name: string; version: string; subpath: string }

function parseNpmSpec(raw: string): ParsedNpmSpec {
    let rest = raw.startsWith('npm:') ? raw.slice(4).replace(/^\//, '') : raw;
    while (rest.startsWith('/')) rest = rest.slice(1);
    let name = '', ver = '', sub = '';

    if (rest.startsWith('@')) {
        const sl = rest.indexOf('/');
        if (sl === -1 || sl === 1) throw err(ErrorKind.InvalidSpecifier, `Invalid scoped package: ${raw}`);
        const scope = rest.slice(0, sl); rest = rest.slice(sl + 1);
        const at = rest.indexOf('@'), sl2 = rest.indexOf('/');
        if (at !== -1 && (sl2 === -1 || at < sl2)) {
            name = `${scope}/${rest.slice(0, at)}`;
            const after = rest.slice(at + 1);
            if (!after) throw err(ErrorKind.InvalidSpecifier, `Invalid npm specifier (empty version): ${raw}`);
            const sl3 = after.indexOf('/');
            ver = sl3 === -1 ? after : after.slice(0, sl3);
            sub = sl3 === -1 ? '' : after.slice(sl3 + 1);
        } else if (sl2 !== -1) {
            name = `${scope}/${rest.slice(0, sl2)}`; sub = rest.slice(sl2 + 1);
        } else { name = `${scope}/${rest}`; }
    } else {
        if (!rest) throw err(ErrorKind.InvalidSpecifier, `Invalid npm specifier (empty): ${raw}`);
        const at = rest.indexOf('@'), sl = rest.indexOf('/');
        if (at !== -1 && (sl === -1 || at < sl)) {
            name = rest.slice(0, at);
            const after = rest.slice(at + 1);
            if (!after) throw err(ErrorKind.InvalidSpecifier, `Invalid npm specifier (empty version): ${raw}`);
            const sl2 = after.indexOf('/');
            ver = sl2 === -1 ? after : after.slice(0, sl2);
            sub = sl2 === -1 ? '' : after.slice(sl2 + 1);
        } else if (sl !== -1) { name = rest.slice(0, sl); sub = rest.slice(sl + 1); }
        else name = rest;
    }
    if (!name) throw err(ErrorKind.InvalidSpecifier, `Invalid npm specifier (no package name): ${raw}`);
    return { name, version: ver || 'latest', subpath: sub };
}

interface NpmMeta {
    versions: Record<string, {
        version: string;
        dist: { tarball: string };
        os?: string[];
        cpu?: string[];
    }>;
    'dist-tags': Record<string, string>;
}

function currentOs(): string {
    if (isWindows) return 'win32';
    if (uname.sysname === 'Darwin') return 'darwin';
    if (uname.sysname === 'Linux') return 'linux';
    if (uname.sysname === 'FreeBSD') return 'freebsd';
    if (uname.sysname === 'OpenBSD') return 'openbsd';
    return uname.sysname.toLowerCase();
}

function currentCpu(): string {
    const machine = String(uname.machine || '').toLowerCase();
    if (machine === 'x86_64' || machine === 'amd64') return 'x64';
    if (machine === 'aarch64' || machine === 'arm64') return 'arm64';
    if (machine === 'i386' || machine === 'i686' || machine === 'x86') return 'ia32';
    if (machine.startsWith('armv7')) return 'arm';
    if (machine.startsWith('arm')) return 'arm';
    return machine;
}

function currentAbi(): 'msvc' | 'gnu' | 'musl' | '' {
    const sys = String(uname.sysname || '').toLowerCase();
    const machine = String(uname.machine || '').toLowerCase();
    let msystem = '';
    let ostype = '';
    try { msystem = String(os.getenv?.('MSYSTEM') ?? '').toLowerCase(); } catch {}
    try { ostype = String(os.getenv?.('OSTYPE') ?? '').toLowerCase(); } catch {}

    if (sys.includes('windows')) {
        if (sys.includes('mingw') || sys.includes('msys') || sys.includes('cygwin')
            || msystem.includes('mingw') || msystem.includes('msys')
            || ostype.includes('msys') || ostype.includes('mingw')) {
            return 'gnu';
        }
        return 'msvc';
    }

    if (sys === 'linux') {
        if (machine.includes('musl') || ostype.includes('musl')) return 'musl';
        return 'gnu';
    }

    return '';
}

function matchesConstraint(list: string[] | undefined, current: string): boolean {
    if (!list || !list.length) return true;
    let allowed = false;
    let hasPositive = false;
    for (const raw of list) {
        const item = String(raw || '').trim();
        if (!item) continue;
        if (item.startsWith('!')) {
            if (item.slice(1) === current) return false;
            continue;
        }
        hasPositive = true;
        if (item === current) allowed = true;
    }
    return hasPositive ? allowed : true;
}

function matchesAbiVariant(pkgName: string, abi: string): boolean {
    if (!abi) return true;
    if (pkgName.endsWith('-msvc')) return abi === 'msvc';
    if (pkgName.endsWith('-gnu')) return abi === 'gnu';
    if (pkgName.endsWith('-musl')) return abi === 'musl';
    return true;
}

export class NpmHandler implements ProtocolHandler {
    readonly protocols = ['npm'];
    private readonly cacheDir: string;
    private npmCfg: NpmConfig | null = null;
    private readonly verCache = new Map<string, string>();
    /** Cache findLocal results per package name + lookup origin. */
    private readonly localCache = new Map<string, string | null>();
    private readonly pendingPostinstall: Array<{ name: string; version: string; dir: string; script: string }> = [];

    constructor(private readonly cfg: RuntimeConfig) {
        this.cacheDir = joinPaths(cfg.cacheDir, 'npm');
    }

    /** Clear version resolution cache */
    clearCache(): void {
        this.verCache.clear();
        this.localCache.clear();
        this.npmCfg = null;
    }

    /** Drain pending postinstall scripts (called by runtime after scan). */
    drainPostinstall(): Array<{ name: string; version: string; dir: string; script: string }> {
        const scripts = this.pendingPostinstall.splice(0);
        return scripts;
    }

    *resolve(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const forceCjs = this.isCjsRequest(attr);
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('npm:')) {
            return yield* this.resolveRelative(spec, parent, forceCjs, onProgress);
        }
        if (spec === '.' && parent.startsWith('npm:')) {
            return yield* this.resolveRelative('.', parent, forceCjs, onProgress);
        }
        if (spec.startsWith('#') && parent.startsWith('npm:')) {
            return yield* this.resolveSubpathImport(spec, parent, forceCjs, onProgress);
        }
        // # imports from local node_modules files — resolve via owning package's "imports"
        if (spec.startsWith('#')) {
            const pkgDir = this.findOwningPackageDir(parent);
            if (pkgDir) {
                const ctx = createCtx(pkgDir, { forceCjs });
                if (ctx) {
                    const resolved = resolveImports(ctx, spec);
                    if (resolved) {
                        const pkg = readPkg(pkgDir);
                        const ver = pkg?.version ?? '0.0.0';
                        const name = pkg?.name ?? 'unknown';
                        return this.toPackageModuleInfo(name, ver, pkgDir, resolved);
                    }
                }
                throw err(ErrorKind.ModuleNotFound, `Cannot resolve "${spec}" in ${pkgDir} - not found in package.json "imports"`);
            }
        }
        const { name, version: parsedRange, subpath } = parseNpmSpec(spec);
        const selfRef = this.resolveSelfReference(parent, name, subpath, forceCjs);
        if (selfRef) return selfRef;
        const range = parsedRange === 'latest'
            ? (yield* this.resolveParentRange(name, parent, onProgress)) ?? parsedRange
            : parsedRange;
        const pkg = yield* this.ensureInstalled(name, range, parent, onProgress);
        return this.resolvePkg(pkg.dir, pkg.resolvedVer, name, subpath, forceCjs);
    }

    tryResolveLocal(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo | null {
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
        const forceCjs = this.isCjsRequest(attr);
        let parsed: ParsedNpmSpec;
        try {
            parsed = parseNpmSpec(spec);
        } catch {
            return null;
        }

        const selfRef = this.resolveSelfReference(parent, parsed.name, parsed.subpath, forceCjs);
        if (selfRef) return selfRef;

        if (this.parentOrigin(parent) === 'cache') return null;

        const local = this.findLocal(parsed.name, parent);
        if (!local) return null;
        const pkg = readPkg(local);
        const resolvedVer = pkg?.version ?? parsed.version;
        return this.resolvePkg(local, resolvedVer, parsed.name, parsed.subpath, forceCjs);
    }

    /**
     * Resolve a binary name to its absolute path.
     * Priority: local node_modules/.bin > lock bin index.
     */
    resolveBin(name: string, cwd: string): string | null {
        if (name.startsWith('/') || name.startsWith('.') || name.includes('/')) return null;

        // 1. Local node_modules/.bin (highest priority)
        const local = findLocalBin(name, cwd);
        if (local) return local;

        // 2. Lock bin index
        const lockBin = this.cfg.lockStore?.getBin(name);
        if (lockBin) return lockBin.path;

        return null;
    }

    localPath(specPath: string): string {
        const { name, version, subpath } = parseNpmSpec(specPath);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${version}`);
        if (!fs.exists(pkgDir)) throw err(ErrorKind.ModuleNotFound, `Package not in cache: ${specPath}`);
        const ctx = createCtx(pkgDir);
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkgDir}`);
        const resolved = resolveSubpath(ctx, subpath || '.');
        if (!resolved) throw err(ErrorKind.ModuleNotFound, `Cannot resolve path for ${specPath}`);
        return resolved.path;
    }

    private static specPath(name: string, version: string, subpath: string): string {
        return `npm:${name}@${version}` + (subpath ? `/${subpath}` : '');
    }

    private static canonicalSubpath(pkgDir: string, localPath: string): string {
        const rel = normalizePath(localPath.slice(pkgDir.length + 1));
        return rel === 'package.json' ? '' : rel;
    }

    private *resolveRelative(spec: string, parent: string, forceCjs: boolean, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const { name, version, subpath } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent, onProgress);
        const ctx = createCtx(pkg.dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);

        /* When the parent is the package root (no subpath), relative imports
         * must resolve from pkg.dir — NOT from the directory of the main entry
         * file.  Otherwise `./dist/foo.cjs` in a package whose main is already
         * `./dist/foo.cjs` would double the `dist/` prefix. */
        let baseDir: string;
        if (!subpath || subpath === '.' || subpath === './') {
            baseDir = pkg.dir;
        } else {
            let parentLocal: string | null = resolveSubpath(ctx, subpath)?.path ?? null;
            if (!parentLocal) {
                const targetName = subpath.split('/').pop()!;
                parentLocal = this.findFileByBasename(pkg.dir, targetName, subpath);
            }
            if (!parentLocal) throw err(ErrorKind.ModuleNotFound, `Cannot resolve parent "${subpath}" in ${name}@${pkg.resolvedVer}`);
            baseDir = dirname(parentLocal);
        }

        const targetLocal = normalizePath(joinPaths(baseDir, spec));
        const resolvedLocal = resolveFile(targetLocal);
        if (!resolvedLocal) throw err(ErrorKind.FileNotFound, `Cannot resolve "${spec}" from "${parent}": file not found at ${targetLocal}`);
        return this.toLocalModuleInfo(name, pkg.resolvedVer, pkg.dir, resolvedLocal);
    }

    private *resolveSubpathImport(spec: string, parent: string, forceCjs: boolean, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const { name, version } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent, onProgress);
        const ctx = createCtx(pkg.dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);
        const resolved = resolveImports(ctx, spec);
        if (!resolved) throw err(ErrorKind.ModuleNotFound, `Cannot resolve "${spec}" in ${name}@${pkg.resolvedVer} - not found in package.json "imports"`);
        return this.toPackageModuleInfo(name, pkg.resolvedVer, pkg.dir, resolved);
    }

    private resolvePkg(dir: string, ver: string, name: string, subpath: string, forceCjs: boolean): ModuleInfo {
        const ctx = createCtx(dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${dir}`);
        const resolved = resolveSubpath(ctx, subpath);
        if (!resolved) {
            // Root entry (subpath === '') with no main/exports: the package has been
            // installed but exposes no runtime entry (e.g. @types/* declaration packages).
            // Return package.json as a no-content leaf so precache can record it without
            // failing — dep scanner skips .json files when looking for further imports.
            if (!subpath) {
                const pkgJson = joinPaths(dir, 'package.json');
                log.debug('npm', () => `${name}@${ver}: no entry point, using package.json as install marker`);
                return {
                    specPath: NpmHandler.specPath(name, ver, subpath),
                    localPath: pkgJson,
                    format: 'esm',
                    fileKind: 'json',
                };
            }
            const pkg = ctx.pkg;
            const hint = pkg.exports
                ? `(exports: ${JSON.stringify(pkg.exports)})`
                : pkg.main ? `(main: "${pkg.main}")` : '(no main field)';
            throw err(ErrorKind.ModuleNotFound,
                `Cannot resolve "${subpath}" in ${name}@${ver} - ${hint}\n` +
                `  The package may not expose a default entry point. Try importing a specific subpath like npm:${name}@${ver}/<file>`);
        }
        return this.toPackageModuleInfo(name, ver, dir, resolved);
    }

    private highestVersion(meta: NpmMeta): string {
        return Object.keys(meta.versions).sort(compareVersions).at(-1)!;
    }

    private findFileByBasename(dir: string, basename: string, subpath: string): string | null {
        const subSuffix = subpath.includes('/') ? subpath.slice(0, subpath.lastIndexOf('/')) : '';
        const results: string[] = [];
        const walk = (d: string) => {
            let entries: string[];
            try { entries = fs.readdir(d); } catch { return; }
            for (const e of entries) {
                const p = joinPaths(d, e);
                try {
                    if (fs.stat(p).isDirectory) {
                        if (e !== 'node_modules') walk(p);
                    } else if (e === basename) {
                        results.push(p);
                    }
                } catch {}
            }
        };
        walk(dir);
        if (!results.length) return null;
        if (subSuffix) {
            for (const r of results) {
                const rel = normalizePath(r.slice(dir.length + 1));
                if (rel.endsWith(subSuffix + '/' + basename)) return r;
            }
        }
        return results[0]!;
    }

    private resolveSelfReference(parent: string, name: string, subpath: string, forceCjs: boolean): ModuleInfo | null {
        if (!parent || (!parent.startsWith('npm:') && !parent.includes(this.cacheDir))) return null;
        const parentPkgDir = this.findOwningPackageDir(parent);
        if (!parentPkgDir) return null;
        const parentPkg = readPkg(parentPkgDir);
        if (!parentPkg?.name || parentPkg.name !== name || !parentPkg.version) return null;
        return this.resolvePkg(parentPkgDir, parentPkg.version, name, subpath, forceCjs);
    }

    private toPackageModuleInfo(name: string, version: string, pkgDir: string, resolved: ResolvedPath): ModuleInfo {
        return {
            specPath: NpmHandler.specPath(name, version, NpmHandler.canonicalSubpath(pkgDir, resolved.path)),
            localPath: resolved.path,
            format: resolved.format,
            fileKind: guessFileKind(resolved.path),
        };
    }

    private toLocalModuleInfo(name: string, version: string, pkgDir: string, localPath: string, format: ModuleFormat = detectFormat(localPath)): ModuleInfo {
        return this.toPackageModuleInfo(name, version, pkgDir, { path: localPath, format });
    }

    private isCjsRequest(attr?: Record<string, any>): boolean {
        return attr?.cjs === true;
    }

    private localCacheKey(name: string, parent?: string): string {
        return `${name}\0${this.localLookupBase(parent)}`;
    }

    private localLookupBase(parent?: string): string {
        if (!parent) return cwd();
        const owner = this.findOwningPackageDir(parent);
        if (owner) return this.realPath(owner) ?? owner;
        if (parent.startsWith('npm:')) return parent;
        return dirname(this.parentFsPath(parent));
    }

    private realPath(path: string): string | null {
        try { return normalizePath(fs.realpath(path)); }
        catch { return null; }
    }

    private parentFsPath(parent: string): string {
        let path = parent.startsWith('file://') ? parent.slice(7) : parent;
        if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
        return normalizePath(path);
    }

    private resolvedParentLocalPath(parent?: string): string | null {
        if (!parent?.startsWith('npm:')) return null;
        const info = this.cfg.lockStore?.getModule(parent);
        if (!info?.localPath) return null;
        const localPath = normalizePath(info.localPath);
        const cacheRoot = normalizePath(this.cacheDir);
        return localPath === cacheRoot || localPath.startsWith(cacheRoot + '/') ? null : localPath;
    }

    private pushNodeModulesSearchDirs(startDir: string, out: string[], seen: Set<string>): void {
        let dir = normalizePath(startDir);
        const root = pathRoot(dir);
        while (dir) {
            const candidate = basename(dir) === 'node_modules' ? dir : joinPaths(dir, 'node_modules');
            if (!seen.has(candidate)) {
                seen.add(candidate);
                out.push(candidate);
            }
            if (dir === root) break;
            const up = dirname(dir);
            if (up === dir) break;
            dir = up;
        }
    }

    private isVirtualProjectNodeModulesPath(path: string): boolean {
        const norm = normalizePath(path);
        return /\/node_modules\/\.[^/]+(?:\/|$)/.test(norm) && !norm.includes('/.pnpm/');
    }

    private lockedVersionForRange(name: string, range: string): string | null {
        const lock = this.cfg.lockStore;
        if (!lock) return null;
        const prefix = `npm:${name}@`;
        const specs = lock.findModuleSpecsByPrefix(prefix);
        const versions = new Set<string>();
        for (const spec of specs) {
            try {
                const parsed = parseNpmSpec(spec);
                if (parsed.name === name && parsed.version) versions.add(parsed.version);
            } catch {}
        }
        if (!versions.size) return null;
        const list = [...versions];
        return matchLatestVersion(list, range)
            ?? (list.includes(range) ? range : null);
    }

    private parentOrigin(parent?: string): 'cache' | 'node_modules' | 'project' | 'none' {
        if (!parent) return 'none';
        const resolvedLocal = this.resolvedParentLocalPath(parent);
        const norm = normalizePath(resolvedLocal ?? (parent.startsWith('npm:') ? parent : this.parentFsPath(parent)));
        const cacheRoot = normalizePath(this.cacheDir);
        if ((parent.startsWith('npm:') && !resolvedLocal) || norm === cacheRoot || norm.startsWith(cacheRoot + '/')) {
            return 'cache';
        }
        if (this.isVirtualProjectNodeModulesPath(norm)) return 'project';
        if (norm.includes('/node_modules/')) return 'node_modules';
        return 'project';
    }

    private findLocal(name: string, parent?: string): string | null {
        const key = this.localCacheKey(name, parent);
        const cached = this.localCache.get(key);
        if (cached !== undefined) return cached;

        const search: string[] = [];
        const seen = new Set<string>();
        const addSearchBase = (base?: string | null) => {
            if (!base) return;
            const normBase = normalizePath(base);
            const real = this.realPath(base);
            // For pnpm-linked package entries (for example .pnpm/node_modules/foo),
            // prefer the real package directory first so package-private deps win
            // over the hoisted virtual .pnpm/node_modules layer.
            if (real && real !== normBase) {
                this.pushNodeModulesSearchDirs(real, search, seen);
            }
            this.pushNodeModulesSearchDirs(normBase, search, seen);
        };
        if (parent) {
            if (parent.startsWith('npm:')) addSearchBase(this.findOwningPackageDir(parent) ?? this.cacheDir);
            else {
                addSearchBase(dirname(this.parentFsPath(parent)));
                addSearchBase(this.findOwningPackageDir(parent));
            }
        }
        addSearchBase(cwd());
        for (const sp of search) {
            const p = joinPaths(sp, name);
            try {
                if (fs.stat(p).isDirectory && fs.exists(joinPaths(p, 'package.json'))) {
                    this.indexLocalBins(p, name);
                    this.localCache.set(key, p);
                    return p;
                }
            } catch {}
        }
        this.localCache.set(key, null);
        return null;
    }

    private findOwningPackageDir(parent: string): string | null {
        if (!parent) return null;
        if (parent.startsWith('npm:')) {
            const resolvedLocal = this.resolvedParentLocalPath(parent);
            if (resolvedLocal) return this.findOwningPackageDir(resolvedLocal);
            const { name, version } = parseNpmSpec(parent);
            if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
                const pkgDir = joinPaths(this.cacheDir, `${name}@${version}`);
                if (fs.exists(joinPaths(pkgDir, 'package.json'))) return pkgDir;
            }
            return null;
        }
        let dir = dirname(this.parentFsPath(parent));
        const root = pathRoot(dir);
        while (dir && dir !== root) {
            const pkgPath = joinPaths(dir, 'package.json');
            if (!this.isVirtualProjectNodeModulesPath(dir) && fs.exists(pkgPath)) return dir;
            const up = dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        const pkgPath = joinPaths(dir, 'package.json');
        return fs.exists(pkgPath) ? dir : null;
    }

    private *resolveParentRange(name: string, parent: string, onProgress?: ProgressCallback): Flow<string | null> {
        let pkgDir = this.findOwningPackageDir(parent);
        if (!pkgDir && parent.startsWith('npm:')) {
            const parsed = parseNpmSpec(parent);
            const installed = yield* this.ensureInstalled(parsed.name, parsed.version, parent, onProgress);
            pkgDir = installed.dir;
        }
        if (!pkgDir) return null;
        const pkg = readPkg(pkgDir);
        if (!pkg) return null;
        return pkg.dependencies?.[name]
            ?? (this.parentOrigin(parent) === 'project' ? pkg.devDependencies?.[name] : null)
            ?? pkg.optionalDependencies?.[name]
            ?? pkg.peerDependencies?.[name]
            ?? null;
    }

    private indexLocalBins(pkgDir: string, name: string): void {
        const pkg = readPkg(pkgDir);
        if (!pkg) return;
        const binMap = getBinMap(pkg);
        for (const [binName, relPath] of Object.entries(binMap)) {
            const absPath = joinPaths(pkgDir, relPath);
            if (fs.exists(absPath)) {
                this.cfg.lockStore?.addBin(binName, absPath, `${name}@local`);
            }
        }
    }

    private getNpmCfg(): NpmConfig {
        return (this.npmCfg ??= loadNpmConfig());
    }

    private *ensureInstalled(name: string, version: string, parent?: string, onProgress?: ProgressCallback): Flow<{ dir: string; resolvedVer: string }> {
        const origin = this.parentOrigin(parent);
        const locked = this.lockedVersionForRange(name, version);
        if (locked) {
            const lockedDir = joinPaths(this.cacheDir, `${name}@${locked}`);
            const lockedExists = yield { type: StepType.FS_EXISTS, path: lockedDir };
            if (lockedExists) {
                return { dir: lockedDir, resolvedVer: locked };
            }
        }
        if (origin !== 'cache') {
            const local = this.findLocal(name, parent);
            if (local) {
                const pkg = readPkg(local);
                return { dir: local, resolvedVer: pkg?.version ?? version };
            }
        }
        if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
            const exactDir = joinPaths(this.cacheDir, `${name}@${version}`);
            const exactExists = yield { type: StepType.FS_EXISTS, path: exactDir };
            if (exactExists) return { dir: exactDir, resolvedVer: version };
        }
        const exactVer = yield* this.resolveVersion(name, version, onProgress);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        const exists = yield { type: StepType.FS_EXISTS, path: pkgDir };
        if (!exists) {
            if (!this.cfg.silent && !isatty) log.download(`${name}@${exactVer}`);
            yield* this.install(name, exactVer, pkgDir, onProgress);
        }
        return { dir: pkgDir, resolvedVer: exactVer };
    }

    private *resolveVersion(name: string, range: string, onProgress?: ProgressCallback): Flow<string> {
        const key = `${name}@${range}`;
        if (this.verCache.has(key)) return this.verCache.get(key)!;
        const meta = yield* this.fetchMeta(name, onProgress);
        const tags = meta['dist-tags'] ?? {};
        let resolved: string;
        if (!range || range === 'latest') resolved = tags.latest ?? this.highestVersion(meta);
        else if (tags[range]) resolved = tags[range]!;
        else if (/^\d+\.\d+\.\d+/.test(range) && meta.versions[range]) resolved = range;
        else resolved = matchLatestVersion(Object.keys(meta.versions), range) ?? tags.latest ?? this.highestVersion(meta);
        this.verCache.set(key, resolved);
        return resolved;
    }

    private *fetchMeta(name: string, onProgress?: ProgressCallback): Flow<NpmMeta> {
        const cfg = this.getNpmCfg();
        const registry = (name.startsWith('@') && cfg.scopeRegistries[name.split('/')[0]!])
            ? cfg.scopeRegistries[name.split('/')[0]!]!
            : cfg.registry;
        const cacheFile = joinPaths(this.cacheDir, name, 'meta.json');
        const cacheTs = cacheFile + '.ts';
        const hasMeta = yield { type: StepType.FS_EXISTS, path: cacheFile };
        const hasTs = yield { type: StepType.FS_EXISTS, path: cacheTs };
        if (hasMeta && hasTs) {
            try {
                const tsText = (yield { type: StepType.FS_READ_TEXT, path: cacheTs }) as string;
                const age = Date.now() - +(tsText || '0');
                if (age < 24 * 60 * 60 * 1000) {
                    return safeParse<NpmMeta>((yield { type: StepType.FS_READ_TEXT, path: cacheFile }) as string);
                }
            } catch {}
        }
        const url = `${registry}/${name}`;
        log.debug('npm', () => `fetch meta ${name} <- ${url}`);
        const started = Date.now();
        const { body } = yield {
            type: StepType.NET_FETCH,
            url,
            headers: { 'User-Agent': 'cts/' + version, Accept: 'application/json' },
            timeout: this.cfg.requestTimeout,
            onProgress,
        };
        log.debug('npm', () => `fetched meta ${name} ${fmtBytes(body.byteLength)} in ${Date.now() - started}ms`);
        const meta = safeParse<NpmMeta>(engine.decodeString(body));
        yield { type: StepType.FS_ENSURE_DIR, path: dirname(cacheFile) };
        yield { type: StepType.FS_WRITE_TEXT, path: cacheFile, text: JSON.stringify(meta, null, 2) };
        yield { type: StepType.FS_WRITE_TEXT, path: cacheTs, text: String(Date.now()) };
        return meta;
    }

    private *install(name: string, ver: string, dir: string, onProgress?: ProgressCallback): Flow<void> {
        const meta = yield* this.fetchMeta(name, onProgress);
        const tarball = meta.versions[ver]?.dist.tarball;
        if (!tarball) throw err(ErrorKind.VersionNotFound, `Version ${ver} not found for ${name}`);
        log.debug('npm', () => `fetch tarball ${name}@${ver} <- ${tarball}`);
        const fetchStarted = Date.now();
        const { body } = yield { type: StepType.NET_FETCH, url: tarball, timeout: this.cfg.requestTimeout, onProgress };
        log.debug('npm', () => `fetched tarball ${name}@${ver} ${fmtBytes(body.byteLength)} in ${Date.now() - fetchStarted}ms`);
        log.debug('npm', () => `extract ${name}@${ver} ${fmtBytes(body.byteLength)}`);
        const extractStarted = Date.now();
        const files = (yield { type: StepType.ARCHIVE_UNTAR_GZ, data: body }) as TarFile[];
        const fileBytes = files.reduce((n, f) => n + (f.type === 'file' ? f.size : 0), 0);
        log.debug('npm', () => `extracted ${name}@${ver}: ${files.length} entries, ${fmtBytes(fileBytes)} in ${Date.now() - extractStarted}ms`);
        yield { type: StepType.FS_ENSURE_DIR, path: dir };
        log.debug('npm', () => `write ${name}@${ver} -> ${dir}`);
        const writeStarted = Date.now();
        yield* this.writeArchive(dir, files);
        log.debug('npm', () => `wrote ${name}@${ver} in ${Date.now() - writeStarted}ms`);
        yield* this.indexInstalledBins(name, ver, dir);
        yield* this.installOptionalDeps(dir, onProgress);
        // Record postinstall script for deferred execution (cno cache only)
        const pkg = readPkg(dir);
        const postinstall = pkg?.scripts?.postinstall;
        if (postinstall && typeof postinstall === 'string' && postinstall.trim()) {
            this.pendingPostinstall.push({ name, version: ver, dir, script: postinstall });
            log.debug('npm', () => `postinstall queued: ${name}@${ver}`);
        }
    }

    /** Try to install each optionalDependency. Failures are non-fatal (platform mismatch, etc). */
    private *installOptionalDeps(dir: string, onProgress?: ProgressCallback): Flow<void> {
        const pkg = readPkg(dir);
        if (!pkg?.optionalDependencies) return;
        const opts = Object.entries(pkg.optionalDependencies);
        if (!opts.length) return;
        log.debug('npm', () => `optional deps for ${pkg.name}: ${opts.map(([n]) => n).join(', ')}`);
        const osName = currentOs();
        const cpuName = currentCpu();
        const abiName = currentAbi();
        for (const [depName, depRange] of opts) {
            try {
                const depMeta = yield* this.fetchMeta(depName, onProgress);
                const exactVer = yield* this.resolveVersion(depName, depRange, onProgress);
                const versionMeta = depMeta.versions[exactVer];
                if (!versionMeta) continue;
                if (!matchesConstraint(versionMeta.os, osName) || !matchesConstraint(versionMeta.cpu, cpuName)) {
                    log.debug('npm', () => `optional dep skipped: ${depName}@${exactVer} (platform mismatch: ${osName}/${cpuName})`);
                    continue;
                }
                if (!matchesAbiVariant(depName, abiName)) {
                    log.debug('npm', () => `optional dep skipped: ${depName}@${exactVer} (abi mismatch: ${abiName || 'unknown'})`);
                    continue;
                }
                const depDir = joinPaths(this.cacheDir, `${depName}@${exactVer}`);
                const exists = yield { type: StepType.FS_EXISTS, path: depDir };
                if (!exists) {
                    if (!this.cfg.silent && !isatty) log.download(`${depName}@${exactVer} (optional)`);
                    yield* this.install(depName, exactVer, depDir, onProgress);
                    log.debug('npm', () => `optional dep installed: ${depName}@${exactVer}`);
                }
            } catch (e) {
                log.debug('npm', () => `optional dep skipped: ${depName} (${e instanceof Error ? e.message : String(e)})`);
            }
        }
    }

    private *indexInstalledBins(name: string, ver: string, dir: string): Flow<void> {
        const pkg = readPkg(dir);
        if (!pkg) return;
        const binMap = getBinMap(pkg);
        const spec = `${name}@${ver}`;
        for (const [binName, relPath] of Object.entries(binMap)) {
            const absPath = joinPaths(dir, relPath);
            if (fs.exists(absPath)) {
                this.cfg.lockStore?.addBin(binName, absPath, spec);
                log.debug('bin', () => `indexed: ${binName} → ${absPath} (${spec})`);
            }
        }
    }

    private *writeArchive(dir: string, files: TarFile[]): Flow<void> {
        const seen = new Set<string>();
        for (const f of files) {
            let p = f.path;
            if (p.startsWith('package/')) p = p.slice(8);
            const target = joinPaths(dir, p);
            if (f.type === 'dir') {
                if (!seen.has(target)) {
                    yield { type: StepType.FS_ENSURE_DIR, path: target };
                    seen.add(target);
                }
                continue;
            }
            const d = dirname(target);
            if (!seen.has(d)) {
                yield { type: StepType.FS_ENSURE_DIR, path: d };
                seen.add(d);
            }
            yield { type: StepType.FS_WRITE_BYTES, path: target, data: f.content };
        }
    }
}
