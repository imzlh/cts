import type { RuntimeConfig, ModuleInfo, ModuleFormat, LifecycleScriptEntry } from '../../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { expectFetch, expectTarFiles, expectText, StepType, type Flow, type TarFile, type ProgressCallback } from '../../flow';
import { joinPaths, dirname, basename, extname, normalizePath, toPosixPath, pathRoot, cwd, hasLeadingSlashDrive } from '../../utils/path';
import { readText, resolveFile, clearNegativeCache, ensureDir } from '../../utils/io';
import { matchLatestVersion, latestVersion, latestRecordVersion, matchLatestRecordVersion, safeParse, fmtBytes } from '../../utils/misc';
import { detectFormat, detectPackageJsonFormat, readPkg, createCtx, resolveSubpath, resolveImports, getBinMap, isPackageSubpathBlockedByExports, isRootExportRuntimeless, packagePathNotExportedError, packageImportNotDefinedError, type ResolveCtx, type ResolvedPath } from '../pkg';
import { err, ErrorKind } from '../../errors';
import { log } from '../../utils/log';
import { isatty } from '../../utils/progress';
import { uname, isWindows, getMemoryTier } from '../../utils/index';
import { findLocalBin } from '../../utils/bin';
import pkg from '../../../package.json';

const version = String(pkg.version ?? '0.0.0');

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

function env(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}

function chmodQuietly(path: string, mode: number): void {
    try {
        fs.chmod(path, mode);
    } catch {
        // Preserve install/link progress; execution will surface permissions.
    }
}

function normalizeNpmrcValue(raw: string): string {
    let value = raw.trim();
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if ((c === 35 || c === 59) && i > 0 && value.charCodeAt(i - 1) <= 32) {
            value = value.slice(0, i).trimEnd();
            break;
        }
    }
    const first = value.charCodeAt(0);
    const last = value.charCodeAt(value.length - 1);
    return value.length >= 2 && (first === 34 || first === 39) && last === first
        ? value.slice(1, -1)
        : value;
}

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
            const v = normalizeNpmrcValue(line.slice(eq + 1));
            if (k === 'registry' && (override || cfg.registry === 'https://registry.npmjs.org'))
                cfg.registry = trimRegistry(v);
            else if ((k === '_authToken' || k === 'authToken') && (override || !cfg.authToken))
                cfg.authToken = v;
            else if (k.startsWith('@') && k.endsWith(':registry'))
                cfg.scopeRegistries[k.slice(0, -9)] ??= trimRegistry(v);
            else if (k.includes(':_authToken') || k.includes(':authToken'))
                cfg.scopeTokens[k] ??= v;
        }
    };
    try {
        const p = joinPaths(cwd(), '.npmrc');
        if (fs.exists(p)) parse(readText(p), true);
    } catch {}
    try {
        const p = joinPaths(toPosixPath(String(os.homeDir ?? '/root')), '.npmrc');
        if (fs.exists(p)) parse(readText(p), false);
    } catch {}
    const registry = env('NPM_CONFIG_REGISTRY');
    if (registry) cfg.registry = trimRegistry(registry);
    const token = env('NPM_TOKEN') ?? env('NODE_AUTH_TOKEN');
    if (token) cfg.authToken = token;
    return cfg;
}

interface ParsedNpmSpec { name: string; version: string; subpath: string }

function rejectVersionAfterSubpath(raw: string, name: string, subpath: string): void {
    const at = subpath.lastIndexOf('@');
    if (at <= 0) return;
    const version = subpath.slice(at + 1);
    if (!startsWithVersionish(version)) return;
    const fixedSubpath = subpath.slice(0, at);
    throw err(ErrorKind.InvalidSpecifier,
        `Invalid package specifier '${raw}'. Did you mean to write 'npm:${name}@${version}/${fixedSubpath}'? ` +
        `If not, add a version requirement to the specifier.`);
}

function parseNpmSpec(raw: string): ParsedNpmSpec {
    let rest = raw.startsWith('npm:') ? raw.slice(4) : raw;
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
        } else if (sl !== -1) {
            name = rest.slice(0, sl);
            sub = rest.slice(sl + 1);
        } else {
            name = rest;
        }
    }
    if (!name) throw err(ErrorKind.InvalidSpecifier, `Invalid npm specifier (no package name): ${raw}`);
    rejectVersionAfterSubpath(raw, name, sub);
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
    const msystem = String(env('MSYSTEM') ?? '').toLowerCase();
    const ostype = String(env('OSTYPE') ?? '').toLowerCase();

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

function recordKeysForLog(record: Record<string, string>): string {
    let out = '';
    for (const key in record) {
        if (out) out += ', ';
        out += key;
    }
    return out;
}

function isDigitCode(c: number): boolean {
    return c >= 48 && c <= 57;
}

function isAsciiAlpha(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isSemverSuffixCode(c: number): boolean {
    return isDigitCode(c) || isAsciiAlpha(c) || c === 45 || c === 46;
}

function hasSemverPrefix(value: string): boolean {
    let dots = 0, partDigits = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (isDigitCode(c)) {
            partDigits++;
            continue;
        }
        if (c !== 46 || partDigits === 0) break;
        dots++;
        if (dots === 3) return false;
        if (dots === 2) return i + 1 < value.length && isDigitCode(value.charCodeAt(i + 1));
        partDigits = 0;
    }
    return false;
}

function isExactSemver(value: string): boolean {
    let dots = 0, partDigits = 0, suffix = false;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (!suffix) {
            if (isDigitCode(c)) {
                partDigits++;
                continue;
            }
            if (c === 46 && dots < 2 && partDigits > 0) {
                dots++;
                partDigits = 0;
                continue;
            }
            if ((c === 45 || c === 43) && dots === 2 && partDigits > 0 && i + 1 < value.length) {
                suffix = true;
                continue;
            }
            return false;
        }
        if (!isSemverSuffixCode(c)) return false;
    }
    return dots === 2 && partDigits > 0;
}

function canUseLocalPackageForRange(range: string): boolean {
    return !range || range === 'latest' || range === '*';
}

function localPackageMatchesRange(version: string | undefined, range: string): boolean {
    if (!version) return canUseLocalPackageForRange(range);
    if (canUseLocalPackageForRange(range)) return true;
    return version === range || matchLatestVersion([version], range) === version;
}

function startsWithVersionish(value: string): boolean {
    let i = 0;
    while (i < value.length && isDigitCode(value.charCodeAt(i))) i++;
    return i > 0 && (i === value.length || value.charCodeAt(i) === 46);
}

function trimRegistry(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}

function lastPathSegment(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
}

function packageScope(name: string): string | undefined {
    if (!name.startsWith('@')) return undefined;
    const slash = name.indexOf('/');
    return slash === -1 ? name : name.slice(0, slash);
}

function isWindowsDrivePath(path: string): boolean {
    return path.length >= 3 && isAsciiAlpha(path.charCodeAt(0)) && path.charCodeAt(1) === 58 && path.charCodeAt(2) === 47;
}

function isVirtualProjectNodeModules(norm: string): boolean {
    if (norm.includes('/.pnpm/')) return false;
    let index = -1;
    while ((index = norm.indexOf('/node_modules/.', index + 1)) !== -1) {
        const next = norm.charCodeAt(index + 16);
        if (next !== 47 && !Number.isNaN(next)) return true;
    }
    return false;
}

export class NpmHandler implements ProtocolHandler {
    readonly protocols = ['npm'];
    private readonly cacheDir: string;
    private npmCfg: NpmConfig | null = null;
    private readonly verCache = new Map<string, string>();
    /** Cache findLocal results per package name + lookup origin. */
    private readonly localCache = new Map<string, string | null>();
    /** Cache findOwningPackageDir results per parent — same parent is looked up
     *  more than once per resolve() call (self-reference check, then local lookup). */
    private readonly ownerDirCache = new Map<string, string | null>();
    private readonly specFormat = new Map<string, ModuleFormat>();
    private readonly specLocalPath = new Map<string, string>();
    private readonly dependenciesChecked = new Set<string>();
    private readonly pendingLifecycle: LifecycleScriptEntry[] = [];
    private readonly queuedLifecycle = new Set<string>();

    constructor(private readonly cfg: RuntimeConfig) {
        this.cacheDir = joinPaths(cfg.cacheDir, 'npm');
    }

    /** Clear version resolution cache */
    clearCache(): void {
        this.verCache.clear();
        this.localCache.clear();
        this.ownerDirCache.clear();
        this.specFormat.clear();
        this.specLocalPath.clear();
        this.dependenciesChecked.clear();
        this.npmCfg = null;
    }

    /** Drain deferred npm lifecycle scripts (called by runtime after scan). */
    drainLifecycleScripts(): LifecycleScriptEntry[] {
        const scripts = this.pendingLifecycle.splice(0);
        return scripts;
    }

    private ctxOptions(forceCjs?: boolean): { forceCjs?: boolean; conditions?: string[] } {
        return { forceCjs, conditions: this.cfg.conditions };
    }

    *resolve(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Flow<ModuleInfo> {
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
            const ctx = pkgDir ? createCtx(pkgDir, this.ctxOptions(forceCjs)) : null;
            const resolved = ctx ? resolveImports(ctx, spec) : null;
            if (resolved && pkgDir) {
                const pkg = readPkg(pkgDir);
                return this.toPackageModuleInfo(pkg?.name ?? 'unknown', pkg?.version ?? '0.0.0', pkgDir, resolved);
            }
            throw packageImportNotDefinedError(spec, pkgDir ?? '', parent);
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

    tryResolveLocal(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo | null {
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
        const forceCjs = this.isCjsRequest(attr);
        let parsed: ParsedNpmSpec;
        try {
            parsed = parseNpmSpec(spec);
        } catch {
            return null;
        }
        if (!canUseLocalPackageForRange(parsed.version)) return null;

        const selfRef = this.resolveSelfReference(parent, parsed.name, parsed.subpath, forceCjs);
        if (selfRef) return selfRef;

        const origin = this.parentOrigin(parent);
        if (origin === 'cache') return null;

        const local = this.findLocal(parsed.name, parent);
        if (!local) return null;
        const pkg = readPkg(local);
        const resolvedVer = pkg?.version ?? parsed.version;
        return this.resolvePkg(local, resolvedVer, parsed.name, parsed.subpath, forceCjs);
    }

    tryResolveLocalFile(localPath: string, attr?: Record<string, unknown>): ModuleInfo | null {
        const normalized = normalizePath(localPath);
        if (!normalized.includes('/node_modules/')) return null;
        const pkgDir = this.findOwningPackageDir(normalized);
        if (!pkgDir) return null;
        const pkg = readPkg(pkgDir);
        if (!pkg?.name) return null;
        const format = detectPackageJsonFormat(normalized) ?? detectFormat(normalized);
        return this.toLocalModuleInfo(pkg.name, pkg.version ?? '0.0.0', pkgDir, normalized, format);
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
        const ctx = createCtx(pkgDir, this.ctxOptions());
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkgDir}`);
        const blockedByExports = isPackageSubpathBlockedByExports(ctx, subpath);
        if (blockedByExports && (subpath || !isRootExportRuntimeless(ctx))) {
            throw packagePathNotExportedError(NpmHandler.specPath(name, version, subpath));
        }
        const resolved = blockedByExports ? null : resolveSubpath(ctx, subpath || '.');
        if (!resolved) {
            // Mirrors resolvePkg()'s types-only-exports marker: keep in sync.
            if (!subpath) return joinPaths(pkgDir, 'package.json');
            throw err(ErrorKind.ModuleNotFound, `Cannot resolve path for ${specPath}`);
        }
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
        const ctx = createCtx(pkg.dir, this.ctxOptions(forceCjs));
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
                const targetName = lastPathSegment(subpath);
                if (!targetName) throw err(ErrorKind.ModuleNotFound, `Cannot resolve parent "${subpath}" in ${name}@${pkg.resolvedVer}`);
                parentLocal = this.findFileByBasename(pkg.dir, targetName, subpath);
            }
            if (!parentLocal) throw err(ErrorKind.ModuleNotFound, `Cannot resolve parent "${subpath}" in ${name}@${pkg.resolvedVer}`);
            baseDir = dirname(parentLocal);
        }

        const targetLocal = normalizePath(joinPaths(baseDir, spec));
        const resolvedLocal = resolveFile(targetLocal);
        if (!resolvedLocal) throw err(ErrorKind.FileNotFound, `Cannot resolve "${spec}" from "${parent}": file not found at ${targetLocal}`);
        return this.toLocalModuleInfo(name, pkg.resolvedVer, pkg.dir, resolvedLocal,
            this.relativeFormat(parent, resolvedLocal, forceCjs));
    }

    private *resolveSubpathImport(spec: string, parent: string, forceCjs: boolean, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const { name, version } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent, onProgress);
        const ctx = createCtx(pkg.dir, this.ctxOptions(forceCjs));
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);
        const resolved = resolveImports(ctx, spec);
        if (!resolved) throw packageImportNotDefinedError(spec, pkg.dir, parent);
        return this.toPackageModuleInfo(name, pkg.resolvedVer, pkg.dir, resolved);
    }

    private resolvePkg(dir: string, ver: string, name: string, subpath: string, forceCjs: boolean): ModuleInfo {
        const ctx = createCtx(dir, this.ctxOptions(forceCjs));
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${dir}`);
        // types-only "." exports (e.g. @types/react 19.x) fall through to the marker below;
        // a real format mismatch (e.g. cjs-only package required via import) still throws.
        const blockedByExports = isPackageSubpathBlockedByExports(ctx, subpath);
        if (blockedByExports && (subpath || !isRootExportRuntimeless(ctx))) {
            throw packagePathNotExportedError(NpmHandler.specPath(name, ver, subpath));
        }
        const resolved = blockedByExports ? null : resolveSubpath(ctx, subpath);
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
        const version = latestRecordVersion(meta.versions);
        if (!version) throw err(ErrorKind.VersionNotFound, 'No versions found in npm metadata');
        return version;
    }

    private findFileByBasename(dir: string, basename: string, subpath: string): string | null {
        const subSuffix = subpath.includes('/') ? subpath.slice(0, subpath.lastIndexOf('/')) : '';
        const results: string[] = [];
        const walk = (d: string) => {
            let entries: string[];
            try {
                entries = fs.readdir(d);
            } catch {
                return;
            }
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
        return results[0] ?? null;
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
        const specPath = NpmHandler.specPath(name, version, NpmHandler.canonicalSubpath(pkgDir, resolved.path));
        this.specFormat.set(specPath, resolved.format);
        this.specLocalPath.set(specPath, resolved.path);
        return {
            specPath,
            localPath: resolved.path,
            format: resolved.format,
            fileKind: resolved.fileKind ?? guessFileKind(resolved.path),
        };
    }

    private toLocalModuleInfo(name: string, version: string, pkgDir: string, localPath: string, format: ModuleFormat = detectFormat(localPath)): ModuleInfo {
        return this.toPackageModuleInfo(name, version, pkgDir, { path: localPath, format });
    }

    private relativeFormat(parent: string, localPath: string, forceCjs: boolean): ModuleFormat {
        const ext = extname(localPath);
        if (ext === '.cjs' || ext === '.cts' || ext === '.node') return 'cjs';
        if (ext === '.mjs' || ext === '.mts') return 'esm';
        if (forceCjs) return detectPackageJsonFormat(localPath) ?? detectFormat(localPath);
        const parentFormat = this.specFormat.get(parent);
        if (parentFormat === 'esm' && this.shouldInheritEsmFormat(parent, localPath)) return 'esm';
        const parentInfo = this.cfg.lockStore?.getModule(parent);
        if (parentInfo?.format === 'esm' && this.shouldInheritEsmFormat(parent, localPath)) return 'esm';
        return detectFormat(localPath);
    }

    private parentLocalPath(parent: string): string | null {
        return this.specLocalPath.get(parent)
            ?? this.cfg.lockStore?.getModule(parent)?.localPath
            ?? null;
    }

    private shouldInheritEsmFormat(parent: string, localPath: string): boolean {
        const parentLocal = this.parentLocalPath(parent);
        if (!parentLocal) return true;
        const parentExt = extname(parentLocal);
        if (parentExt === '.mjs' || parentExt === '.mts') return false;
        const parentScope = this.findOwningPackageDir(parentLocal);
        const targetScope = this.findOwningPackageDir(localPath);
        if (!parentScope || !targetScope) return true;
        return normalizePath(parentScope) === normalizePath(targetScope);
    }

    private isCjsRequest(attr?: Record<string, unknown>): boolean {
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
        try {
            return normalizePath(fs.realpath(path));
        } catch {
            return null;
        }
    }

    private parentFsPath(parent: string): string {
        let path = parent.startsWith('file://') ? parent.slice(7) : parent;
        if (hasLeadingSlashDrive(path)) path = path.slice(1);
        return normalizePath(path);
    }

    private resolvedParentLocalPath(parent?: string): string | null {
        if (!parent?.startsWith('npm:')) return null;
        const tracked = this.specLocalPath.get(parent);
        if (tracked) {
            const localPath = normalizePath(tracked);
            const cacheRoot = normalizePath(this.cacheDir);
            return localPath === cacheRoot || localPath.startsWith(cacheRoot + '/') ? null : localPath;
        }
        const info = this.cfg.lockStore?.getModule(parent);
        if (!info?.localPath) return null;
        const localPath = normalizePath(info.localPath);
        const cacheRoot = normalizePath(this.cacheDir);
        if (localPath !== cacheRoot && !localPath.startsWith(cacheRoot + '/')) {
            try {
                if (fs.exists(localPath) && (this.isVirtualProjectNodeModulesPath(localPath) || localPath.includes('/node_modules/'))) {
                    return localPath;
                }
            } catch {}
            return null;
        }
        try {
            if (normalizePath(this.localPath(parent)) !== localPath) return null;
        } catch {
            return null;
        }
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
        return isVirtualProjectNodeModules(norm);
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
        if (!range || range === 'latest' || range === '*') {
            return latestVersion(list);
        }
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
        const cached = this.ownerDirCache.get(parent);
        if (cached !== undefined) return cached;
        const result = this._findOwningPackageDir(parent);
        this.ownerDirCache.set(parent, result);
        return result;
    }

    private _findOwningPackageDir(parent: string): string | null {
        if (!parent) return null;
        if (parent.startsWith('npm:')) {
            const resolvedLocal = this.resolvedParentLocalPath(parent);
            if (resolvedLocal) return this.findOwningPackageDir(resolvedLocal);
            const { name, version } = parseNpmSpec(parent);
            if (isExactSemver(version)) {
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
            // Check package.json, not just the directory — a directory can exist
            // but be incomplete (interrupted extraction, crash mid-install), and
            // a bare FS_EXISTS on the dir would wrongly treat that as "installed"
            // forever, since nothing else ever re-triggers install() afterward.
            const lockedExists = yield { type: StepType.FS_EXISTS, path: joinPaths(lockedDir, 'package.json') };
            if (lockedExists) {
                this.linkCacheAlias(name, lockedDir);
                yield* this.indexInstalledBins(name, locked, lockedDir);
                yield* this.installDependencies(name, locked, lockedDir, onProgress);
                yield* this.installOptionalDeps(lockedDir, onProgress);
                this.queueLifecycleScripts(name, locked, lockedDir);
                return { dir: lockedDir, resolvedVer: locked };
            }
        }
        if (origin !== 'cache') {
            const local = this.findLocal(name, parent);
            const pkg = local ? readPkg(local) : null;
            if (local && localPackageMatchesRange(pkg?.version, version)) {
                return { dir: local, resolvedVer: pkg?.version ?? version };
            }
        }
        if (isExactSemver(version)) {
            const exactDir = joinPaths(this.cacheDir, `${name}@${version}`);
            const exactExists = yield { type: StepType.FS_EXISTS, path: joinPaths(exactDir, 'package.json') };
            if (exactExists) {
                this.linkCacheAlias(name, exactDir);
                yield* this.indexInstalledBins(name, version, exactDir);
                yield* this.installDependencies(name, version, exactDir, onProgress);
                yield* this.installOptionalDeps(exactDir, onProgress);
                this.queueLifecycleScripts(name, version, exactDir);
                return { dir: exactDir, resolvedVer: version };
            }
            const local = this.findLocal(name, parent);
            const pkg = local ? readPkg(local) : null;
            if (local && pkg?.version === version) {
                return { dir: local, resolvedVer: version };
            }
        }
        const exactVer = yield* this.resolveVersion(name, version, onProgress);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        const exists = yield { type: StepType.FS_EXISTS, path: joinPaths(pkgDir, 'package.json') };
        if (!exists) {
            if (this.cfg.cachedOnly) {
                throw err(ErrorKind.ModuleNotFound, `npm package not found in cache: "${name}", --cached-only is specified.`);
            }
            if (!this.cfg.silent && !isatty) log.download(`${name}@${exactVer}`);
            yield* this.installOnce(name, exactVer, pkgDir, onProgress);
        } else {
            this.linkCacheAlias(name, pkgDir);
            yield* this.indexInstalledBins(name, exactVer, pkgDir);
            yield* this.installDependencies(name, exactVer, pkgDir, onProgress);
            yield* this.installOptionalDeps(pkgDir, onProgress);
            this.queueLifecycleScripts(name, exactVer, pkgDir);
        }
        return { dir: pkgDir, resolvedVer: exactVer };
    }

    private *resolveVersion(name: string, range: string, onProgress?: ProgressCallback): Flow<string> {
        const key = `${name}@${range}`;
        const cached = this.verCache.get(key);
        if (cached !== undefined) return cached;
        const meta = yield* this.fetchMeta(name, onProgress);
        const tags = meta['dist-tags'] ?? {};
        let resolved: string;
        if (!range || range === 'latest') resolved = tags.latest ?? this.highestVersion(meta);
        else if (tags[range]) resolved = tags[range];
        else if (hasSemverPrefix(range) && meta.versions[range]) resolved = range;
        else {
            const matched = matchLatestRecordVersion(meta.versions, range);
            if (!matched) throw err(ErrorKind.VersionNotFound, `Could not find npm package '${name}' matching '${range}'.`);
            resolved = matched;
        }
        this.verCache.set(key, resolved);
        return resolved;
    }

    private *fetchMeta(name: string, onProgress?: ProgressCallback): Flow<NpmMeta> {
        const cfg = this.getNpmCfg();
        const scope = packageScope(name);
        const registry = scope ? cfg.scopeRegistries[scope] ?? cfg.registry : cfg.registry;
        const cacheFile = joinPaths(this.cacheDir, name, 'meta.json');
        const cacheTs = cacheFile + '.ts';
        const hasMeta = yield { type: StepType.FS_EXISTS, path: cacheFile };
        const hasTs = yield { type: StepType.FS_EXISTS, path: cacheTs };
        if (hasMeta && hasTs) {
            try {
                const tsText = expectText(yield { type: StepType.FS_READ_TEXT, path: cacheTs });
                const age = Date.now() - +(tsText || '0');
                if (age < 24 * 60 * 60 * 1000) {
                    return safeParse<NpmMeta>(expectText(yield { type: StepType.FS_READ_TEXT, path: cacheFile }));
                }
            } catch {}
        }
        if (this.cfg.cachedOnly) {
            throw err(ErrorKind.ModuleNotFound, `npm package not found in cache: "${name}", --cached-only is specified.`);
        }
        const url = `${registry}/${name}`;
        log.debug('npm', () => `fetch meta ${name} <- ${url}`);
        const started = Date.now();
        const { body } = expectFetch(yield {
            type: StepType.NET_FETCH,
            url,
            headers: { 'User-Agent': 'cts/' + version, Accept: 'application/json' },
            timeout: this.cfg.requestTimeout,
            onProgress,
        });
        log.debug('npm', () => `fetched meta ${name} ${fmtBytes(body.byteLength)} in ${Date.now() - started}ms`);
        const meta = safeParse<NpmMeta>(engine.decodeString(body));
        yield { type: StepType.FS_ENSURE_DIR, path: dirname(cacheFile) };
        // Cache the raw response bytes verbatim — avoids re-serializing the
        // whole (often multi-MB) metadata object just to persist it.
        yield { type: StepType.FS_WRITE_BYTES, path: cacheFile, data: body };
        yield { type: StepType.FS_WRITE_TEXT, path: cacheTs, text: String(Date.now()) };
        return meta;
    }

    private *install(name: string, ver: string, dir: string, onProgress?: ProgressCallback): Flow<void> {
        const meta = yield* this.fetchMeta(name, onProgress);
        const tarball = meta.versions[ver]?.dist.tarball;
        if (!tarball) throw err(ErrorKind.VersionNotFound, `Version ${ver} not found for ${name}`);
        log.debug('npm', () => `fetch tarball ${name}@${ver} <- ${tarball}`);
        const fetchStarted = Date.now();
        const { body } = expectFetch(yield { type: StepType.NET_FETCH, url: tarball, timeout: this.cfg.requestTimeout, onProgress });
        log.debug('npm', () => `fetched tarball ${name}@${ver} ${fmtBytes(body.byteLength)} in ${Date.now() - fetchStarted}ms`);
        log.debug('npm', () => `extract ${name}@${ver} ${fmtBytes(body.byteLength)}`);
        const extractStarted = Date.now();
        const files = expectTarFiles(yield { type: StepType.ARCHIVE_UNTAR_GZ, data: body });
        let fileBytes = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (f?.type === 'file') fileBytes += f.size;
        }
        log.debug('npm', () => `extracted ${name}@${ver}: ${files.length} entries, ${fmtBytes(fileBytes)} in ${Date.now() - extractStarted}ms`);
        yield { type: StepType.FS_ENSURE_DIR, path: dir };
        log.debug('npm', () => `write ${name}@${ver} -> ${dir}`);
        const writeStarted = Date.now();
        yield* this.writeArchive(dir, files);
        log.debug('npm', () => `wrote ${name}@${ver} in ${Date.now() - writeStarted}ms`);
        this.linkCacheAlias(name, dir);
        // A concurrent worker resolving a sibling file mid-extraction (before this
        // writeArchive call finished) may have permanently marked it as missing in
        // the resolver's negative file-existence cache. Clear it now that this
        // package is fully on disk so those siblings get a fair re-check.
        clearNegativeCache();
        yield* this.indexInstalledBins(name, ver, dir);
        yield* this.installDependencies(name, ver, dir, onProgress);
        yield* this.installOptionalDeps(dir, onProgress);
        this.queueLifecycleScripts(name, ver, dir);
    }

    private *installOnce(name: string, ver: string, dir: string, onProgress?: ProgressCallback): Flow<void> {
        yield {
            type: StepType.FLOW,
            key: `npm-install:${name}@${ver}`,
            flow: this.install(name, ver, dir, onProgress),
        };
    }

    private queueLifecycleScripts(name: string, ver: string, dir: string): void {
        if (!this.cfg.persistLock || this.cfg.ignoreScripts) return;
        const pkg = readPkg(dir);
        for (const lifecycle of ['install', 'postinstall'] as const) {
            const script = pkg?.scripts?.[lifecycle];
            if (!script || typeof script !== 'string' || !script.trim()) continue;
            const key = `${name}@${ver}\0${lifecycle}`;
            if (this.queuedLifecycle.has(key)) continue;
            this.queuedLifecycle.add(key);
            this.pendingLifecycle.push({ name, version: ver, dir, lifecycle, script });
            log.debug('npm', () => `${lifecycle} queued: ${name}@${ver}`);
        }
    }

    private *installDependencies(name: string, ver: string, dir: string, onProgress?: ProgressCallback): Flow<void> {
        if (!this.cfg.persistLock) return;

        const key = `${name}@${ver}`;
        if (this.dependenciesChecked.has(key)) return;
        this.dependenciesChecked.add(key);

        const pkg = readPkg(dir);
        const deps = pkg?.dependencies;
        if (!deps) return;

        const depNames = recordKeysForLog(deps);
        if (!depNames) return;
        log.debug('npm', () => `deps for ${key}: ${depNames}`);
        const flows: Flow<void>[] = [];
        for (const depName in deps) {
            const depRange = deps[depName]!;
            flows.push(this.installDependency(dir, name, ver, depName, depRange, onProgress));
        }
        yield { type: StepType.FLOW_ALL, flows, concurrency: this.packageInstallConcurrency() };
    }

    private *installDependency(
        parentDir: string,
        parentName: string,
        parentVer: string,
        name: string,
        range: string,
        onProgress?: ProgressCallback,
    ): Flow<void> {
        const dep = yield* this.ensureInstalled(name, range, `npm:${parentName}@${parentVer}`, onProgress);
        this.linkDependency(parentDir, name, dep.dir);
    }

    /** Try to install each optionalDependency. Failures are non-fatal (platform mismatch, etc). */
    private *installOptionalDeps(dir: string, onProgress?: ProgressCallback): Flow<void> {
        const pkg = readPkg(dir);
        const opts = pkg?.optionalDependencies;
        if (!opts) return;
        const optionalDepNames = recordKeysForLog(opts);
        if (!optionalDepNames) return;
        log.debug('npm', () => `optional deps for ${pkg.name}: ${optionalDepNames}`);
        const osName = currentOs();
        const cpuName = currentCpu();
        const abiName = currentAbi();
        const flows: Flow<void>[] = [];
        for (const depName in opts) {
            const depRange = opts[depName]!;
            flows.push(this.installOptionalDependency(dir, depName, depRange, osName, cpuName, abiName, onProgress));
        }
        yield { type: StepType.FLOW_ALL, flows, concurrency: this.packageInstallConcurrency() };
    }

    private *installOptionalDependency(
        parentDir: string,
        name: string,
        range: string,
        osName: string,
        cpuName: string,
        abiName: string,
        onProgress?: ProgressCallback,
    ): Flow<void> {
        try {
            const meta = yield* this.fetchMeta(name, onProgress);
            const ver = yield* this.resolveVersion(name, range, onProgress);
            const versionMeta = meta.versions[ver];
            if (!versionMeta) return;
            if (!matchesConstraint(versionMeta.os, osName) || !matchesConstraint(versionMeta.cpu, cpuName)) {
                log.debug('npm', () => `optional dep skipped: ${name}@${ver} (platform mismatch: ${osName}/${cpuName})`);
                return;
            }
            if (!matchesAbiVariant(name, abiName)) {
                log.debug('npm', () => `optional dep skipped: ${name}@${ver} (abi mismatch: ${abiName || 'unknown'})`);
                return;
            }
            const depDir = joinPaths(this.cacheDir, `${name}@${ver}`);
            const exists = yield { type: StepType.FS_EXISTS, path: joinPaths(depDir, 'package.json') };
            if (!exists) {
                if (!this.cfg.silent && !isatty) log.download(`${name}@${ver} (optional)`);
                yield* this.installOnce(name, ver, depDir, onProgress);
                log.debug('npm', () => `optional dep installed: ${name}@${ver}`);
            }
            this.linkDependency(parentDir, name, depDir);
        } catch (e) {
            log.debug('npm', () => `optional dep skipped: ${name} (${e instanceof Error ? e.message : String(e)})`);
        }
    }

    private packageInstallConcurrency(): number {
        return { low: 2, normal: 4, high: 8 }[getMemoryTier()] ?? 4;
    }

    private linkDependency(parentDir: string, depName: string, depDir: string): void {
        const target = joinPaths(parentDir, 'node_modules', depName);
        try {
            if (!fs.exists(joinPaths(depDir, 'package.json'))) return;
            if (!fs.exists(joinPaths(target, 'package.json'))) {
                ensureDir(dirname(target));
                fs.symlink(depDir, target);
            }
            this.linkDependencyBins(parentDir, depDir);
        } catch (e) {
            log.debug('npm', () => `dependency link skipped: ${depName} -> ${target} (${e instanceof Error ? e.message : String(e)})`);
        }
    }

    private linkCacheAlias(name: string, dir: string): void {
        const target = joinPaths(this.cacheDir, name);
        try {
            if (target === dir) return;
            if (fs.exists(joinPaths(target, 'package.json'))) return;
            if (fs.exists(target)) {
                for (const entry of fs.readdir(dir)) {
                    const source = joinPaths(dir, entry);
                    const dest = joinPaths(target, entry);
                    if (fs.exists(dest)) continue;
                    fs.symlink(source, dest);
                }
                return;
            }
            ensureDir(dirname(target));
            fs.symlink(dir, target);
        } catch (e) {
            log.debug('npm', () => `cache alias skipped: ${name} -> ${target} (${e instanceof Error ? e.message : String(e)})`);
        }
    }

    private linkDependencyBins(parentDir: string, depDir: string): void {
        const pkg = readPkg(depDir);
        if (!pkg) return;
        const binMap = getBinMap(pkg);
        const binDir = joinPaths(parentDir, 'node_modules', '.bin');
        for (const [binName, relPath] of Object.entries(binMap)) {
            const source = joinPaths(depDir, relPath);
            const target = joinPaths(binDir, binName);
            try {
                if (!fs.exists(source) || fs.exists(target)) continue;
                ensureDir(binDir);
                fs.symlink(source, target);
                chmodQuietly(source, 0o755);
            } catch (e) {
                log.debug('bin', () => `bin link skipped: ${binName} -> ${target} (${e instanceof Error ? e.message : String(e)})`);
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

    // package.json is written last, once every other file has landed on disk —
    // ensureInstalled() treats "package.json exists" as "fully installed", and
    // concurrent scan workers race to check immediately after it becomes true.
    // Writing it eagerly (in tarball order) lets a worker see "installed" while
    // sibling files (e.g. a relative-import target) are still mid-extraction,
    // which permanently poisons the resolver's negative file-existence cache.
    private *writeArchive(dir: string, files: TarFile[]): Flow<void> {
        const archiveRoot = this.detectArchiveRoot(files);
        const seen = new Set<string>();
        let pkgJsonFile: TarFile | null = null;
        let pkgJsonTarget = '';
        for (const f of files) {
            let p = this.normalizeArchivePath(f.path, f.type, archiveRoot);
            if (!p) continue;
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
            if (p === 'package.json') {
                pkgJsonFile = f;
                pkgJsonTarget = target;
                continue;
            }
            yield { type: StepType.FS_WRITE_BYTES, path: target, data: f.content };
            if (f.type === 'file' && (f.mode & 0o111)) {
                chmodQuietly(target, f.mode & 0o777);
            }
        }
        if (pkgJsonFile) {
            yield { type: StepType.FS_WRITE_BYTES, path: pkgJsonTarget, data: pkgJsonFile.content };
            if (pkgJsonFile.mode & 0o111) {
                chmodQuietly(pkgJsonTarget, pkgJsonFile.mode & 0o777);
            }
        }
    }

    private detectArchiveRoot(files: TarFile[]): string | null {
        let root: string | null = null;
        for (const f of files) {
            const p = this.cleanArchivePath(f.path);
            if (!p || p === 'pax_global_header' || p.startsWith('pax_global_header/')) continue;
            if (p === 'package' || p.startsWith('package/')) return 'package';
            const slash = p.indexOf('/');
            const seg = slash === -1 ? p : p.slice(0, slash);
            if (!root) root = seg;
            else if (root !== seg) return null;
            if (slash === -1 && f.type !== 'dir') return null;
        }
        return root;
    }

    private normalizeArchivePath(path: string, type: TarFile['type'], archiveRoot: string | null): string | null {
        let p = this.cleanArchivePath(path);
        if (!p || p === 'pax_global_header' || p.startsWith('pax_global_header/')) return null;
        if (archiveRoot) {
            if (p === archiveRoot) return type === 'dir' ? null : '';
            if (p.startsWith(archiveRoot + '/')) p = p.slice(archiveRoot.length + 1);
        }
        return p || null;
    }

    private cleanArchivePath(path: string): string {
        let p = path;
        while (p.startsWith('./')) p = p.slice(2);
        p = normalizePath(p);
        if (
            p.startsWith('/') ||
            hasLeadingSlashDrive(p) ||
            isWindowsDrivePath(p) ||
            p === '..' ||
            p.startsWith('../') ||
            p.includes('/../')
        ) {
            throw err(ErrorKind.InvalidSpecifier, `Unsafe npm tarball path: ${path}`);
        }
        return p;
    }
}
