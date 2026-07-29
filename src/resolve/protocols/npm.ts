import type { RuntimeConfig, ModuleInfo, ModuleFormat, LifecycleScriptEntry } from '../../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { expectFetch, expectTarFiles, expectText, StepType, type Flow, type TarFile, type ProgressCallback } from '../../flow';
import { joinPaths, dirname, basename, extname, normalizePath, toPosixPath, pathRoot, cwd, hasLeadingSlashDrive } from '../../utils/path';
import { readText, resolveFile, clearNegativeCache, ensureDir } from '../../utils/io';
import { matchLatestVersion, latestVersion, latestRecordVersion, matchLatestRecordVersion, safeParse, fmtBytes, hashString, matchesIntegrity, hasSupportedIntegrity, isValidNpmPackageName } from '../../utils/misc';
import { detectFormat, detectPackageJsonFormat, readPkg, createCtx, resolveSubpath, resolveImports, getBinMap, resolvePackageBinPath, isPackageSubpathBlockedByExports, isRootExportRuntimeless, packagePathNotExportedError, packageImportNotDefinedError, type ResolveCtx, type ResolvedPath } from '../pkg';
import { err, ErrorKind } from '../../errors';
import { log } from '../../utils/log';
import { isatty } from '../../utils/progress';
import { uname, isWindows, getMemoryTier } from '../../utils/index';
import { findLocalBin } from '../../utils/bin';
import pkg from '../../../package.json';

const version = String(pkg.version ?? '0.0.0');
/** Shared empty cycle path for top-level ensure/prepare entry points. */
const EMPTY_CYCLE: ReadonlySet<string> = new Set();

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

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

/** Directory package link (node_modules/pkg → store). Windows needs type=dir. */
function symlinkDir(target: string, linkPath: string): void {
    if (isWindows) fs.symlink(target, linkPath, 'dir');
    else fs.symlink(target, linkPath);
}

/** File bin link (node_modules/.bin/x → script). Windows needs type=file. */
function symlinkFile(target: string, linkPath: string): void {
    if (isWindows) fs.symlink(target, linkPath, 'file');
    else fs.symlink(target, linkPath);
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

function assertNpmPackageName(name: string): void {
    if (!isValidNpmPackageName(name)) {
        throw err(ErrorKind.InvalidSpecifier, `Invalid npm package name: ${name}`);
    }
}

function assertSafeNpmSubpath(raw: string, subpath: string): void {
    if (!subpath) return;
    const normalized = toPosixPath(subpath);
    if (normalized.startsWith('/') || normalized.includes('\0') || /^[a-z]:\//i.test(normalized) ||
        normalized.split('/').some(segment => segment === '.' || segment === '..')) {
        throw err(ErrorKind.InvalidSpecifier, `Unsafe npm package subpath: ${raw}`);
    }
}

function isSafeStoreVersionSegment(version: string): boolean {
    return !!version && !version.includes('/') && !version.includes('\\') && !version.includes('\0') &&
        !version.includes(':') && !/[\u0000-\u0020\u007f]/.test(version);
}

function isSafeNpmBinName(name: string): boolean {
    return !!name && name !== '.' && name !== '..' && !name.includes('/') &&
        !name.includes('\\') && !name.includes('\0') && !name.includes(':');
}

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
            // http(s) tarball / github: ranges contain '/' — keep as version.
            if (isOpaqueVersionRange(after)) {
                ver = after;
                sub = '';
            } else {
                const sl3 = after.indexOf('/');
                ver = sl3 === -1 ? after : after.slice(0, sl3);
                sub = sl3 === -1 ? '' : after.slice(sl3 + 1);
            }
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
            if (isOpaqueVersionRange(after)) {
                ver = after;
                sub = '';
            } else {
                const sl2 = after.indexOf('/');
                ver = sl2 === -1 ? after : after.slice(0, sl2);
                sub = sl2 === -1 ? '' : after.slice(sl2 + 1);
            }
        } else if (sl !== -1) {
            name = rest.slice(0, sl);
            sub = rest.slice(sl + 1);
        } else {
            name = rest;
        }
    }
    if (!name) throw err(ErrorKind.InvalidSpecifier, `Invalid npm specifier (no package name): ${raw}`);
    assertNpmPackageName(name);
    rejectVersionAfterSubpath(raw, name, sub);
    const suffixIndex = sub.search(/[?#]/);
    if (suffixIndex !== -1) sub = sub.slice(0, suffixIndex);
    assertSafeNpmSubpath(raw, sub);
    return { name, version: ver || 'latest', subpath: sub };
}

interface NpmDist {
    tarball: string;
    integrity?: string;
    shasum?: string;
}

interface NpmMeta {
    versions: Record<string, {
        version: string;
        dist: NpmDist;
        os?: string[];
        cpu?: string[];
    }>;
    'dist-tags': Record<string, string>;
}

function verifyRegistryTarball(data: Uint8Array | ArrayBuffer, dist: NpmDist, name: string, ver: string): void {
    const integrity = typeof dist.integrity === 'string' ? dist.integrity.trim() : '';
    let valid = false;
    // Only trust the SRI path when it carries a supported (sha256+) token —
    // a sha1-only SRI must fall through to the shasum check, not fail outright.
    if (integrity && hasSupportedIntegrity(integrity)) {
        valid = matchesIntegrity(data, integrity);
    } else if (typeof dist.shasum === 'string' && dist.shasum.trim()) {
        const expected = dist.shasum.trim().toLowerCase();
        valid = /^[0-9a-f]{40}$/.test(expected) &&
            crypto.hexEncode(crypto.sha1(data)).toLowerCase() === expected;
    }
    if (!valid) {
        throw err(ErrorKind.NetworkError,
            `Integrity check failed for npm:${name}@${ver} from ${dist.tarball}`);
    }
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

/** Strip a single leading `v`/`V` when the rest looks like a semver (v0.2.1). */
function stripLeadingV(value: string): string {
    if (value.length < 2) return value;
    const c0 = value.charCodeAt(0);
    if (c0 !== 118 && c0 !== 86) return value; // v / V
    const c1 = value.charCodeAt(1);
    if (!isDigitCode(c1)) return value;
    return value.slice(1);
}

function isExactSemver(value: string): boolean {
    value = stripLeadingV(value);
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

/** package.json dep values like https://cdn…/pkg-1.0.0.tgz (npm/yarn/pnpm). */
function isTarballUrl(range: string): boolean {
    if (!(range.startsWith('https://') || range.startsWith('http://'))) return false;
    const path = range.split(/[?#]/, 1)[0]!.toLowerCase();
    return path.endsWith('.tgz')
        || path.endsWith('.tar.gz')
        || path.endsWith('.tar')
        || path.endsWith('.tar.bz2');
}

/**
 * github:owner/repo[#ref] and git+https://github.com/… — used by packages such
 * as @marktext/file-icons (`file-icons: "github:file-icons/atom"`).
 * Map to codeload tar.gz so the existing tarball install path can extract them.
 */
function githubRangeToTarballUrl(range: string): string | null {
    const raw = range.trim();
    if (!raw) return null;

    let owner = '';
    let repo = '';
    let ref = 'HEAD';

    if (raw.startsWith('github:')) {
        let rest = raw.slice(7);
        const hash = rest.indexOf('#');
        if (hash !== -1) {
            ref = rest.slice(hash + 1) || 'HEAD';
            rest = rest.slice(0, hash);
        }
        const parts = rest.split('/').filter(Boolean);
        if (parts.length < 2) return null;
        owner = parts[0]!;
        repo = parts[1]!;
    } else {
        // git+https://github.com/owner/repo.git#ref
        // https://github.com/owner/repo(.git)?#ref
        const m = raw.match(
            /^(?:git\+)?https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.*))?$/i,
        );
        if (!m) return null;
        owner = m[1]!;
        repo = m[2]!;
        if (m[3]) ref = m[3];
    }

    if (repo.endsWith('.git')) repo = repo.slice(0, -4);
    if (!owner || !repo) return null;
    // codeload accepts branch / tag / commit; HEAD resolves to default branch.
    return `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
}

function isGithubDepRange(range: string): boolean {
    return githubRangeToTarballUrl(range) !== null;
}

/** Version field that must not be split on '/' (tarball URL or github:…). */
function isOpaqueVersionRange(range: string): boolean {
    return isTarballUrl(range) || isGithubDepRange(range);
}

/** Best-effort version from URL filename: …/xlsx-0.20.3.tgz → 0.20.3 */
function versionHintFromTarballUrl(url: string): string | null {
    const path = url.split(/[?#]/, 1)[0]!;
    const slash = path.lastIndexOf('/');
    const base = slash === -1 ? path : path.slice(slash + 1);
    // name-1.2.3.tgz / name-1.2.3-beta.1.tar.gz
    const m = base.match(/-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)\.(?:tgz|tar\.gz|tar|tar\.bz2)$/i);
    return m?.[1] ?? null;
}

/**
 * Store identity for URL/github installs. package.json version alone collides
 * when two different dist pins claim the same semver (or both lack one).
 */
function urlStoreVersion(url: string, baseVer: string): string {
    const normalized = stripLeadingV(baseVer);
    const base = isExactSemver(normalized) ? normalized : '0.0.0';
    return `${base}+u${hashString(url).slice(0, 8)}`;
}

/** True for store keys produced by urlStoreVersion (`1.2.3+u` + 8 hex). */
function isUrlStoreVersion(ver: string): boolean {
    const i = ver.lastIndexOf('+u');
    if (i < 0) return false;
    const tag = ver.slice(i + 2);
    if (tag.length !== 8) return false;
    for (let j = 0; j < 8; j++) {
        const c = tag.charCodeAt(j);
        if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
    }
    return true;
}

/** Required + optional package.json edges for install-view BFS (mirrors linker). */
function collectInstallGraphDeps(pkg: {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}): Array<{ name: string; range: string; optional: boolean }> {
    const out: Array<{ name: string; range: string; optional: boolean }> = [];
    const index = new Map<string, number>();
    const push = (name: string, range: string, optional: boolean, prefer = false) => {
        if (!isValidNpmPackageName(name)) return;
        const i = index.get(name);
        if (i !== undefined) {
            // npm: optionalDependencies wins over dependencies for same name.
            if (prefer) out[i] = { name, range: range || '*', optional };
            return;
        }
        index.set(name, out.length);
        out.push({ name, range: range || '*', optional });
    };
    const deps = pkg.dependencies;
    if (deps) for (const n in deps) push(n, deps[n] ?? '*', false);
    const peers = pkg.peerDependencies;
    const meta = pkg.peerDependenciesMeta;
    if (peers) {
        for (const n in peers) {
            push(n, peers[n] ?? '*', meta?.[n]?.optional === true);
        }
    }
    const opt = pkg.optionalDependencies;
    if (opt) for (const n in opt) push(n, opt[n] ?? '*', true, true);
    return out;
}

function localPackageMatchesRange(version: string | undefined, range: string): boolean {
    if (!version) return canUseLocalPackageForRange(range);
    if (canUseLocalPackageForRange(range)) return true;
    // URL / github ranges pin a dist, not a semver — never treat a local copy as a match.
    if (isOpaqueVersionRange(range)) return false;
    return version === range || matchLatestVersion([version], range) === version;
}

function packageJsonVersionFromTar(files: TarFile[]): string | null {
    for (const f of files) {
        if (f.type !== 'file') continue;
        const p = f.path.replace(/\\/g, '/');
        // package/package.json or bare package.json
        if (p === 'package.json' || p.endsWith('/package.json')) {
            // Prefer the shallowest package.json (npm pack root).
            if (p !== 'package.json' && p.split('/').length > 2) continue;
            try {
                const text = engine.decodeString(f.content);
                const pkg = safeParse<{ version?: string }>(text);
                if (pkg?.version && typeof pkg.version === 'string') return pkg.version;
            } catch {}
        }
    }
    // Second pass: any package.json
    for (const f of files) {
        if (f.type !== 'file') continue;
        const p = f.path.replace(/\\/g, '/');
        if (!p.endsWith('package.json')) continue;
        try {
            const text = engine.decodeString(f.content);
            const pkg = safeParse<{ version?: string }>(text);
            if (pkg?.version && typeof pkg.version === 'string') return pkg.version;
        } catch {}
    }
    return null;
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

/** Drop the scheme, keeping the nerf-dart `//host/path` form npm tokens key on. */
function stripUrlScheme(u: string): string {
    const i = u.indexOf('://');
    return i === -1 ? u : u.slice(i + 1);
}

/** True when `target` is the base registry itself or a path beneath it. */
function urlUnderBase(target: string, base: string): boolean {
    let b = base.endsWith('/') ? base.slice(0, -1) : base;
    if (!target.startsWith(b)) return false;
    const rest = target.slice(b.length);
    return rest === '' || rest.charCodeAt(0) === 47;
}

/**
 * Authorization header for a registry request — only when the URL targets a
 * configured registry host. Scoped/registry tokens (nerf-dart keys) win; the
 * default `authToken` applies solely to the configured default registry.
 * Tokens are never sent to arbitrary third-party hosts.
 */
function npmAuthHeaders(url: string, cfg: NpmConfig): Record<string, string> {
    const target = stripUrlScheme(url);
    for (const key in cfg.scopeTokens) {
        const suffix = key.endsWith(':_authToken') ? ':_authToken'
            : key.endsWith(':authToken') ? ':authToken' : null;
        if (!suffix) continue;
        const ref = key.slice(0, -suffix.length);
        if (!ref.startsWith('//')) continue;
        if (urlUnderBase(target, ref)) {
            return { Authorization: `Bearer ${cfg.scopeTokens[key]}` };
        }
    }
    if (cfg.authToken) {
        const base = stripUrlScheme(trimRegistry(cfg.registry));
        if (urlUnderBase(target, base)) {
            return { Authorization: `Bearer ${cfg.authToken}` };
        }
    }
    return {};
}

function isWindowsDrivePath(path: string): boolean {
    return path.length >= 3 && isAsciiAlpha(path.charCodeAt(0)) && path.charCodeAt(1) === 58 && path.charCodeAt(2) === 47;
}

function isVirtualProjectNodeModules(norm: string): boolean {
    if (norm.includes('/.pnpm/')) return false;
    let index = -1;
    while ((index = norm.indexOf('/node_modules/.', index + 1)) !== -1) {
        const next = norm.charCodeAt(index + 15);
        if (next !== 47 && !Number.isNaN(next)) return true;
    }
    return false;
}

type PackageImportResolver = (
    spec: string,
    parent: string,
    attr?: Record<string, unknown>,
    onProgress?: ProgressCallback,
) => Flow<ModuleInfo>;

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
    /** name@version already had bins/optional/lifecycle prepared this process. */
    private readonly packagesPrepared = new Set<string>();
    /** Process-local registry meta (avoids re-parse + coalesces concurrent fetches). */
    private readonly metaMem = new Map<string, NpmMeta>();
    private readonly pendingLifecycle: LifecycleScriptEntry[] = [];
    private readonly queuedLifecycle = new Set<string>();
    /** Flat-store version lists per package name (avoids readdir thrash). */
    private readonly storeVersionsCache = new Map<string, string[]>();
    /** One readdir of cacheDir / scope dirs for listStoreVersions. */
    private storeRootListing: string[] | null = null;
    private readonly storeScopeListing = new Map<string, string[]>();

    constructor(
        private readonly cfg: RuntimeConfig,
        private readonly packageImportResolver?: PackageImportResolver,
    ) {
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
        this.packagesPrepared.clear();
        this.metaMem.clear();
        this.storeVersionsCache.clear();
        this.storeRootListing = null;
        this.storeScopeListing.clear();
        this.npmCfg = null;
    }

    /** Drain deferred npm lifecycle scripts (called by runtime after scan). */
    drainLifecycleScripts(): LifecycleScriptEntry[] {
        const scripts = this.pendingLifecycle.splice(0);
        return scripts;
    }

    /**
     * Populate the flat store with required package.json deps/peers for the
     * install-view graph (scan seeds + BFS). Soft/hard materialize needs these
     * packages even when import scan never resolved them. Optional deps skipped.
     */
    *ensureInstallGraph(
        seeds: Array<{ name: string; version: string }>,
        onProgress?: ProgressCallback,
    ): Flow<void> {
        const seen = new Set<string>();
        const queue: Array<{ name: string; version: string }> = [];
        for (const s of seeds) {
            if (!s.name || !s.version) continue;
            const key = `${s.name}@${s.version}`;
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push(s);
        }
        while (queue.length > 0) {
            // Batch one BFS layer so FLOW_ALL can parallelize ensureInstalled.
            const layer = queue.splice(0, queue.length);
            const flows: Flow<void>[] = [];
            for (const seed of layer) {
                flows.push(this.ensureInstallGraphNode(seed.name, seed.version, seen, queue, onProgress));
            }
            if (flows.length > 0) {
                yield { type: StepType.FLOW_ALL, flows, concurrency: this.packageInstallConcurrency() };
            }
        }
    }

    private *ensureInstallGraphNode(
        name: string,
        version: string,
        seen: Set<string>,
        queue: Array<{ name: string; version: string }>,
        onProgress?: ProgressCallback,
    ): Flow<void> {
        // Body-only ensure: never prepareInstalledPackage here — a missing
        // required child would throw and abort the whole BFS; materialize
        // fail-closes those. We fill each required edge one hop at a time.
        let dir: string;
        let ver: string;
        try {
            const body = yield* this.ensurePackageInStore(name, version, onProgress);
            if (!body) return;
            dir = body.dir;
            ver = body.resolvedVer;
        } catch (e) {
            log.debug('npm', () =>
                `install-graph seed ensure failed: ${name}@${version}: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        const manifest = readPkg(dir);
        if (!manifest) return;
        this.linkCacheAlias(name, dir);
        const declared = collectInstallGraphDeps(manifest);
        for (const dep of declared) {
            if (dep.optional) continue;
            let child: { dir: string; resolvedVer: string } | null = null;
            try {
                child = yield* this.ensurePackageInStore(dep.name, dep.range, onProgress);
            } catch (e) {
                log.debug('npm', () =>
                    `install-graph ensure failed: ${dep.name}@${dep.range} from ${name}@${ver}: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }
            if (!child) continue;
            this.linkDependency(dir, dep.name, child.dir);
            const childKey = `${dep.name}@${child.resolvedVer}`;
            if (!seen.has(childKey)) {
                seen.add(childKey);
                queue.push({ name: dep.name, version: child.resolvedVer });
            }
        }
    }

    /**
     * Ensure name@range is extracted under the flat store (package.json present).
     * Does not walk dependencies — install-graph BFS owns that. Returns null when
     * the package cannot be obtained (cachedOnly miss, etc.) without throwing for
     * pure store misses after a failed fetch attempt path that throws.
     */
    private *ensurePackageInStore(
        name: string,
        range: string,
        onProgress?: ProgressCallback,
    ): Flow<{ dir: string; resolvedVer: string } | null> {
        if (!isValidNpmPackageName(name)) return null;
        if (isTarballUrl(range) || githubRangeToTarballUrl(range)) {
            // Opaque ranges need the full ensure path (URL / github codeload).
            try {
                return yield* this.ensureInstalled(name, range, undefined, onProgress);
            } catch {
                return null;
            }
        }
        const hit = this.findCachedPackageMatching(name, range);
        if (hit) {
            const pkg = readPkg(hit);
            const ver = pkg?.version ?? stripLeadingV(range);
            return { dir: hit, resolvedVer: ver };
        }
        // Not in store (or hollow without package.json): resolve + install body.
        if (this.cfg.cachedOnly) return null;
        const exactRange = stripLeadingV(range);
        let exactVer: string;
        if (isExactSemver(exactRange)) {
            exactVer = exactRange;
        } else {
            exactVer = yield* this.resolveVersion(name, range, onProgress);
        }
        const pkgDir = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        if (!fs.exists(joinPaths(pkgDir, 'package.json'))) {
            if (!this.cfg.silent && !isatty) log.download(`${name}@${exactVer}`);
            // Body-only FLOW (same key as installOnce) — no dep walk under the key.
            yield {
                type: StepType.FLOW,
                key: `npm-install:${name}@${exactVer}`,
                flow: this.installPackageBody(name, exactVer, pkgDir, onProgress),
            };
        }
        return { dir: pkgDir, resolvedVer: exactVer };
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
            return yield* this.resolveSubpathImport(spec, parent, forceCjs, attr, onProgress);
        }
        // # imports from local node_modules files — resolve via owning package's "imports"
        if (spec.startsWith('#')) {
            const pkgDir = this.findOwningPackageDir(parent);
            const ctx = pkgDir ? createCtx(pkgDir, this.ctxOptions(forceCjs)) : null;
            const resolved = ctx ? resolveImports(ctx, spec) : null;
            if (resolved && pkgDir) {
                const pkg = readPkg(pkgDir);
                return yield* this.resolvePackageImportResult(
                    pkg?.name ?? 'unknown', pkg?.version ?? '0.0.0', pkgDir, resolved, parent, attr, onProgress);
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

    /** Bin path: node_modules/.bin then lock index. */
    resolveBin(name: string, cwd: string): string | null {
        if (name.startsWith('/') || name.startsWith('.') || !isSafeNpmBinName(name)) return null;

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
        if (!isSafeStoreVersionSegment(version)) {
            throw err(ErrorKind.InvalidSpecifier, `Unsafe npm package version: ${version}`);
        }
        const pkgDir = joinPaths(this.cacheDir, `${name}@${version}`);
        if (!fs.exists(pkgDir)) throw err(ErrorKind.ModuleNotFound, `Package not in cache: ${specPath}`);
        // Resolved package targets use their physical package-relative path as
        // the canonical module ID. getInfo() must be able to restore that ID
        // without applying package exports a second time.
        if (subpath) {
            const root = normalizePath(pkgDir);
            const candidate = normalizePath(joinPaths(root, subpath));
            if (candidate.startsWith(root + '/')) {
                const direct = resolveFile(candidate);
                if (direct) return direct;
            }
        }
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

    /** Package-relative subpath, or null when localPath escapes pkgDir. */
    private static canonicalSubpath(pkgDir: string, localPath: string): string | null {
        const root = normalizePath(pkgDir);
        const norm = normalizePath(localPath);
        if (norm === root) return '';
        if (!norm.startsWith(root + '/')) return null;
        const rel = norm.slice(root.length + 1);
        return rel === 'package.json' ? '' : rel;
    }

    /** Walk up from a store file to the `<cache>/<name>@<ver>` dir that owns it. */
    private storeOwnerOf(localPath: string): { dir: string; name: string; version: string } | null {
        const root = normalizePath(this.cacheDir);
        let dir = normalizePath(localPath);
        if (!dir.startsWith(root + '/')) return null;
        while (dir.length > root.length) {
            const id = this.storePackageId(dir);
            if (id) return { dir, name: id.name, version: id.version };
            const up = dirname(dir);
            if (up === dir) break;
            dir = normalizePath(up);
        }
        return null;
    }

    private *resolveRelative(spec: string, parent: string, forceCjs: boolean, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const { name, version, subpath } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent, onProgress);
        const ctx = createCtx(pkg.dir, this.ctxOptions(forceCjs));
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);

        /* Root parent: resolve relative from pkg.dir, not main entry dir. */
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

    private *resolveSubpathImport(
        spec: string,
        parent: string,
        forceCjs: boolean,
        attr?: Record<string, unknown>,
        onProgress?: ProgressCallback,
    ): Flow<ModuleInfo> {
        const { name, version } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent, onProgress);
        const ctx = createCtx(pkg.dir, this.ctxOptions(forceCjs));
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);
        const resolved = resolveImports(ctx, spec);
        if (!resolved) throw packageImportNotDefinedError(spec, pkg.dir, parent);
        return yield* this.resolvePackageImportResult(
            name, pkg.resolvedVer, pkg.dir, resolved, parent, attr, onProgress);
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
            // No main/exports: leaf package.json so precache records @types/* without fail.
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
        const subpath = NpmHandler.canonicalSubpath(pkgDir, resolved.path);
        // Escaped pkgDir (e.g. `../../bar/index.js`): slicing by pkgDir.length
        // would mint a subpath under the wrong package and poison the lock.
        if (subpath === null) {
            const real = this.storeOwnerOf(resolved.path);
            if (real) {
                const rel = NpmHandler.canonicalSubpath(real.dir, resolved.path);
                if (rel !== null) return this.finishModuleInfo(real.name, real.version, rel, resolved);
            }
            // Outside the store (project/monorepo sibling): attribute to the
            // package.json that actually owns the file, not the importer.
            const ownerDir = this.findOwningPackageDir(resolved.path);
            const ownerPkg = ownerDir ? readPkg(ownerDir) : null;
            const rel = ownerDir ? NpmHandler.canonicalSubpath(ownerDir, resolved.path) : null;
            if (!ownerDir || !ownerPkg?.name || rel === null) {
                throw err(ErrorKind.ModuleNotFound,
                    `Resolved path escapes package ${name}@${version}: ${resolved.path}`);
            }
            return this.finishModuleInfo(ownerPkg.name, ownerPkg.version ?? '0.0.0', rel, resolved);
        }
        return this.finishModuleInfo(name, version, subpath, resolved);
    }

    private finishModuleInfo(name: string, version: string, subpath: string, resolved: ResolvedPath): ModuleInfo {
        const specPath = NpmHandler.specPath(name, version, subpath) + (resolved.specifierSuffix ?? '');
        this.specFormat.set(specPath, resolved.format);
        this.specLocalPath.set(specPath, resolved.path);
        return {
            specPath,
            localPath: resolved.path,
            format: resolved.format,
            fileKind: resolved.fileKind ?? guessFileKind(resolved.path),
        };
    }

    private *resolvePackageImportResult(
        name: string,
        version: string,
        pkgDir: string,
        resolved: ResolvedPath,
        parent: string,
        attr?: Record<string, unknown>,
        onProgress?: ProgressCallback,
    ): Flow<ModuleInfo> {
        if (resolved.externalSpecifier) {
            if (!this.packageImportResolver) {
                throw err(ErrorKind.Generic, `No resolver is available for package import target "${resolved.path}"`);
            }
            return yield* this.packageImportResolver(resolved.path, parent, attr, onProgress);
        }
        return this.toPackageModuleInfo(name, version, pkgDir, resolved);
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
        // Semver ranges must not pin a URL/github store key from lock.
        const allowUrlTag = isOpaqueVersionRange(range);
        for (const spec of specs) {
            try {
                const parsed = parseNpmSpec(spec);
                if (parsed.name !== name || !parsed.version) continue;
                if (!allowUrlTag && isUrlStoreVersion(parsed.version)) continue;
                versions.add(parsed.version);
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
        if (!isValidNpmPackageName(name)) return null;
        const key = this.localCacheKey(name, parent);
        const cached = this.localCache.get(key);
        if (cached !== undefined) return cached;

        const search: string[] = [];
        const seen = new Set<string>();
        const addSearchBase = (base?: string | null) => {
            if (!base) return;
            const normBase = normalizePath(base);
            const real = this.realPath(base);
            // Prefer real package dir over hoisted .pnpm/node_modules.
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
            const absPath = resolvePackageBinPath(pkgDir, relPath);
            if (absPath) {
                this.cfg.lockStore?.addBin(binName, absPath, `${name}@local`);
            }
        }
    }

    private getNpmCfg(): NpmConfig {
        return (this.npmCfg ??= loadNpmConfig());
    }

    /**
     * Ensure package body + dep graph. `cyclePath` is the call-stack of packages
     * currently being prepared on this chain (not a process-global set): cycle
     * edges return partial without awaiting self.
     */
    private *ensureInstalled(
        name: string,
        version: string,
        parent?: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<{ dir: string; resolvedVer: string }> {
        assertNpmPackageName(name);
        // Direct tarball URL (e.g. sheetjs CDN) — skip registry meta entirely.
        if (isTarballUrl(version)) {
            return yield* this.ensureInstalledFromTarballUrl(name, version, onProgress, cyclePath);
        }
        // github:owner/repo[#ref] → codeload tar.gz (same extract path as tarball URLs).
        const githubUrl = githubRangeToTarballUrl(version);
        if (githubUrl) {
            return yield* this.ensureInstalledFromTarballUrl(name, githubUrl, onProgress, cyclePath);
        }
        const origin = this.parentOrigin(parent);
        const locked = this.lockedVersionForRange(name, version);
        if (locked) {
            const lockedDir = joinPaths(this.cacheDir, `${name}@${locked}`);
            // Need package.json; bare dir may be a partial extract (never re-installed).
            const lockedExists = yield { type: StepType.FS_EXISTS, path: joinPaths(lockedDir, 'package.json') };
            if (lockedExists) {
                yield* this.prepareInstalledPackage(name, locked, lockedDir, onProgress, cyclePath);
                return { dir: lockedDir, resolvedVer: locked };
            }
        }
        // Parent-local install link (project or package node_modules) wins.
        if (origin !== 'cache') {
            const local = this.findLocal(name, parent);
            const pkg = local ? readPkg(local) : null;
            if (local && localPackageMatchesRange(pkg?.version, version)) {
                return { dir: local, resolvedVer: pkg?.version ?? version };
            }
        }
        const exactRange = stripLeadingV(version);
        if (isExactSemver(exactRange)) {
            const exactDir = joinPaths(this.cacheDir, `${name}@${exactRange}`);
            const exactExists = yield { type: StepType.FS_EXISTS, path: joinPaths(exactDir, 'package.json') };
            if (exactExists) {
                yield* this.prepareInstalledPackage(name, exactRange, exactDir, onProgress, cyclePath);
                return { dir: exactDir, resolvedVer: exactRange };
            }
            const local = this.findLocal(name, parent);
            const pkg = local ? readPkg(local) : null;
            if (local && pkg?.version === exactRange) {
                return { dir: local, resolvedVer: exactRange };
            }
        }
        // Warm store hit for ranges (^/~/*): use already-extracted name@version
        // without registry meta. Re-cache of large trees was stuck minutes on
        // resolve npm:foo@^x while foo@y sat in ~/.cts/npm.
        const storeHit = this.findCachedPackageMatching(name, version);
        if (storeHit) {
            const hitPkg = readPkg(storeHit);
            const hitVer = hitPkg?.version ?? exactRange;
            yield* this.prepareInstalledPackage(name, hitVer, storeHit, onProgress, cyclePath);
            this.verCache.set(`${name}@${exactRange}`, hitVer);
            return { dir: storeHit, resolvedVer: hitVer };
        }
        const exactVer = yield* this.resolveVersion(name, version, onProgress);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        const exists = yield { type: StepType.FS_EXISTS, path: joinPaths(pkgDir, 'package.json') };
        if (!exists) {
            if (this.cfg.cachedOnly) {
                throw err(ErrorKind.ModuleNotFound, `npm package not found in cache: "${name}", --cached-only is specified.`);
            }
            if (!this.cfg.silent && !isatty) log.download(`${name}@${exactVer}`);
            yield* this.installOnce(name, exactVer, pkgDir, onProgress, cyclePath);
        } else {
            yield* this.prepareInstalledPackage(name, exactVer, pkgDir, onProgress, cyclePath);
        }
        return { dir: pkgDir, resolvedVer: exactVer };
    }

    /** Disk pin: opaque URL/github range → resolved store version (warm re-cache). */
    private urlRangePinPath(name: string, url: string): string {
        return joinPaths(this.cacheDir, '.url-pins', `${hashString(`${name}\0${url}`)}.txt`);
    }

    private readUrlRangePin(name: string, url: string): string | null {
        try {
            const text = readText(this.urlRangePinPath(name, url)).trim();
            return text || null;
        } catch {
            return null;
        }
    }

    private writeUrlRangePin(name: string, url: string, ver: string): void {
        try {
            const path = this.urlRangePinPath(name, url);
            ensureDir(dirname(path));
            fs.writeFile(path, engine.encodeString(ver));
        } catch {
            // Pin is a warm-path optimisation; install already succeeded.
        }
    }

    /** Install/resolve a package pinned to an http(s) .tgz URL in package.json. */
    private *ensureInstalledFromTarballUrl(
        name: string,
        url: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<{ dir: string; resolvedVer: string }> {
        const cacheKey = `${name}@${url}`;
        const hit = (ver: string): Flow<{ dir: string; resolvedVer: string } | null> => {
            return (function* (self: NpmHandler) {
                const dir = joinPaths(self.cacheDir, `${name}@${ver}`);
                const ok = yield { type: StepType.FS_EXISTS, path: joinPaths(dir, 'package.json') };
                if (!ok) return null;
                yield* self.prepareInstalledPackage(name, ver, dir, onProgress, cyclePath);
                self.verCache.set(cacheKey, ver);
                return { dir, resolvedVer: ver };
            })(this);
        };
        const cachedVer = this.verCache.get(cacheKey);
        if (cachedVer) {
            const ready = yield* hit(cachedVer);
            if (ready) return ready;
        }
        // Cross-process pin for github:/opaque URLs (stores url-tagged version).
        const pinned = this.readUrlRangePin(name, url);
        if (pinned) {
            const ready = yield* hit(pinned);
            if (ready) return ready;
        }
        // Warm path: URL embeds a version — prefer url-tagged store key, then
        // legacy plain name@version from older caches.
        const hinted = versionHintFromTarballUrl(url);
        if (hinted) {
            const tagged = urlStoreVersion(url, hinted);
            const ready = (yield* hit(tagged)) ?? (yield* hit(hinted));
            if (ready) return ready;
        }
        if (this.cfg.cachedOnly) {
            throw err(ErrorKind.ModuleNotFound, `npm package not found in cache: "${name}" (${url}), --cached-only is specified.`);
        }
        if (!this.cfg.silent && !isatty) log.download(`${name} <- ${url}`);
        const result = yield* this.installFromTarballUrlOnce(name, url, onProgress, cyclePath);
        this.verCache.set(cacheKey, result.resolvedVer);
        this.writeUrlRangePin(name, url, result.resolvedVer);
        return result;
    }

    private *installFromTarballUrlOnce(
        name: string,
        url: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<{ dir: string; resolvedVer: string }> {
        const cacheKey = `${name}@${url}`;
        // Body-only FLOW: waiters must not join a prepare that can re-enter this key.
        yield {
            type: StepType.FLOW,
            key: `npm-tarball:${cacheKey}`,
            flow: this.extractFromTarballUrl(name, url, cacheKey, onProgress),
        };
        const ver = this.verCache.get(cacheKey);
        if (!ver) throw err(ErrorKind.Generic, `Failed to install ${name} from ${url}`);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${ver}`);
        yield* this.prepareInstalledPackage(name, ver, pkgDir, onProgress, cyclePath);
        return { dir: pkgDir, resolvedVer: ver };
    }

    /** Fetch+extract URL tarball; sets verCache. Dep walk stays outside the FLOW key. */
    private *extractFromTarballUrl(
        name: string,
        url: string,
        cacheKey: string,
        onProgress?: ProgressCallback,
    ): Flow<void> {
        const cachedVer = this.verCache.get(cacheKey);
        if (cachedVer) {
            const dir = joinPaths(this.cacheDir, `${name}@${cachedVer}`);
            if (fs.exists(joinPaths(dir, 'package.json'))) return;
        }
        log.debug('npm', () => `fetch tarball URL ${name} <- ${url}`);
        const fetchStarted = Date.now();
        const tarRes = expectFetch(yield {
            type: StepType.NET_FETCH,
            url,
            headers: npmAuthHeaders(url, this.getNpmCfg()),
            timeout: this.cfg.requestTimeout,
            onProgress,
        });
        if (tarRes.status < 200 || tarRes.status >= 300) {
            throw err(ErrorKind.NetworkError, `HTTP ${tarRes.status} fetching tarball ${url}`);
        }
        const body = tarRes.body;
        log.debug('npm', () => `fetched tarball URL ${name} ${fmtBytes(body.byteLength)} in ${Date.now() - fetchStarted}ms`);
        const files = expectTarFiles(yield { type: StepType.ARCHIVE_UNTAR_GZ, data: body });
        // Tag with URL hash so two dist pins with the same package.json version
        // never share a store directory (wrong content / silent reuse).
        const baseVer = packageJsonVersionFromTar(files)
            ?? versionHintFromTarballUrl(url)
            ?? '0.0.0';
        const ver = urlStoreVersion(url, baseVer);
        this.verCache.set(cacheKey, ver);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${ver}`);
        if (fs.exists(joinPaths(pkgDir, 'package.json'))) return;
        yield { type: StepType.FS_ENSURE_DIR, path: pkgDir };
        log.debug('npm', () => `write ${name}@${ver} (url) -> ${pkgDir}`);
        yield* this.writeArchive(pkgDir, files);
        this.invalidateStoreListing(name);
        clearNegativeCache();
        yield* this.indexInstalledBins(name, ver, pkgDir);
        this.linkCacheAlias(name, pkgDir);
    }

    /**
     * Once per installed package: alias, bins, deps, optionals, lifecycle.
     * cyclePath is call-stack only (A→B→A → partial). Do NOT coalesce prepare
     * under a FLOW key: FLOW_ALL of mutual deps would cross-await and hang.
     * Body extract still uses npm-install / npm-tarball keys.
     */
    private *prepareInstalledPackage(
        name: string,
        ver: string,
        dir: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
        const key = `${name}@${ver}`;
        if (this.packagesPrepared.has(key)) return;
        // Same prepare chain re-entered via a cycle edge — partial link only.
        if (cyclePath.has(key)) {
            log.debug('npm', () => `prepare cycle ${key} — partial`);
            return;
        }
        // Hollow/partial extract (no package.json): never mark prepared.
        if (!fs.exists(joinPaths(dir, 'package.json'))) return;
        const nextPath = new Set(cyclePath);
        nextPath.add(key);
        this.linkCacheAlias(name, dir);
        yield* this.indexInstalledBins(name, ver, dir);
        // Warm re-cache: complete package-local views skip recursive dep walks.
        if (this.isPackageViewComplete(dir)) {
            this.dependenciesChecked.add(key);
            this.queueLifecycleScripts(name, ver, dir);
            this.packagesPrepared.add(key);
            return;
        }
        yield* this.installDependencies(name, ver, dir, onProgress, nextPath);
        yield* this.installPeerDeps(dir, name, ver, onProgress, nextPath);
        yield* this.installOptionalDeps(dir, onProgress, nextPath);
        this.queueLifecycleScripts(name, ver, dir);
        // Mark prepared only after deps succeed so a failed github: child can
        // retry on the next resolve instead of leaving a hollow package.
        this.packagesPrepared.add(key);
    }

    /**
     * True when every required dependency and required peer is already linked
     * under dir/node_modules and still satisfies its declared range. Optional
     * peers/deps may be absent. Used to skip same-day re-walks of complete
     * store packages — wrong-version leftovers must return false so install
     * can retarget soft links.
     */
    private isPackageViewComplete(dir: string): boolean {
        const pkg = readPkg(dir);
        if (!pkg) return false;
        const nm = joinPaths(dir, 'node_modules');
        const hasSatisfying = (depName: string, range: string): boolean => {
            if (!isValidNpmPackageName(depName)) return false;
            try {
                const linked = joinPaths(nm, depName);
                if (!fs.exists(joinPaths(linked, 'package.json'))) return false;
                // github:/tarball pins land in URL-tagged store dirs (+u…).
                // A plain registry copy must not count as "complete".
                if (isOpaqueVersionRange(range)) {
                    try {
                        const real = fs.realpath(linked);
                        const id = this.storePackageId(real);
                        return !!id && isUrlStoreVersion(id.version);
                    } catch {
                        return false;
                    }
                }
                const child = readPkg(linked);
                return !!child && localPackageMatchesRange(child.version, range);
            } catch {
                return false;
            }
        };
        // optionalDependencies overrides dependencies (npm): those names are optional.
        const optional = pkg.optionalDependencies;
        const deps = pkg.dependencies;
        if (deps) {
            for (const depName in deps) {
                if (optional && Object.prototype.hasOwnProperty.call(optional, depName)) continue;
                if (!hasSatisfying(depName, deps[depName] ?? '*')) return false;
            }
        }
        const peers = pkg.peerDependencies;
        if (peers) {
            const meta = (pkg as { peerDependenciesMeta?: Record<string, { optional?: boolean }> })
                .peerDependenciesMeta;
            for (const peerName in peers) {
                if (meta?.[peerName]?.optional === true) continue;
                if (!hasSatisfying(peerName, peers[peerName] ?? '*')) return false;
            }
        }
        return true;
    }

    private *resolveVersion(name: string, range: string, onProgress?: ProgressCallback): Flow<string> {
        // npm/git often write `v0.2.1`; registry keys are unprefixed.
        const norm = stripLeadingV(range);
        const key = `${name}@${norm}`;
        const cached = this.verCache.get(key);
        if (cached !== undefined) return cached;
        const meta = yield* this.fetchMeta(name, onProgress);
        const tags = meta['dist-tags'] ?? {};
        let resolved: string;
        if (!norm || norm === 'latest') resolved = tags.latest ?? this.highestVersion(meta);
        else if (tags[norm]) resolved = tags[norm];
        else if (hasSemverPrefix(norm) && meta.versions[norm]) resolved = norm;
        else {
            const matched = matchLatestRecordVersion(meta.versions, norm);
            if (!matched) throw err(ErrorKind.VersionNotFound, `Could not find npm package '${name}' matching '${range}'.`);
            resolved = matched;
        }
        if (!isExactSemver(resolved)) {
            throw err(ErrorKind.VersionNotFound, `Registry returned invalid version '${resolved}' for npm package '${name}'.`);
        }
        this.verCache.set(key, resolved);
        // Also cache under the original range so locked lookups with `v` hit.
        if (norm !== range) this.verCache.set(`${name}@${range}`, resolved);
        return resolved;
    }

    private *fetchMeta(name: string, onProgress?: ProgressCallback): Flow<NpmMeta> {
        const mem = this.metaMem.get(name);
        if (mem) return mem;
        // Coalesce concurrent registry GETs for the same package name.
        yield {
            type: StepType.FLOW,
            key: `npm-meta:${name}`,
            flow: this.fetchMetaBody(name, onProgress),
        };
        const after = this.metaMem.get(name);
        if (!after) throw err(ErrorKind.Generic, `Failed to fetch npm metadata for ${name}`);
        return after;
    }

    private *fetchMetaBody(name: string, onProgress?: ProgressCallback): Flow<void> {
        if (this.metaMem.has(name)) return;
        const cfg = this.getNpmCfg();
        const scope = packageScope(name);
        const registry = scope ? cfg.scopeRegistries[scope] ?? cfg.registry : cfg.registry;
        // Under .meta/: <cacheDir>/<name> is the alias symlink target, so writing
        // meta there lands inside a store package body (or blocks the alias).
        const cacheFile = joinPaths(this.cacheDir, '.meta', name, 'meta.json');
        const cacheTs = cacheFile + '.ts';
        const hasMeta = yield { type: StepType.FS_EXISTS, path: cacheFile };
        const hasTs = yield { type: StepType.FS_EXISTS, path: cacheTs };
        if (hasMeta && hasTs) {
            try {
                const tsText = expectText(yield { type: StepType.FS_READ_TEXT, path: cacheTs });
                const age = Date.now() - +(tsText || '0');
                if (age < 24 * 60 * 60 * 1000) {
                    const meta = safeParse<NpmMeta>(expectText(yield { type: StepType.FS_READ_TEXT, path: cacheFile }));
                    this.metaMem.set(name, meta);
                    return;
                }
            } catch {}
        }
        if (this.cfg.cachedOnly) {
            throw err(ErrorKind.ModuleNotFound, `npm package not found in cache: "${name}", --cached-only is specified.`);
        }
        const url = `${registry}/${name}`;
        log.debug('npm', () => `fetch meta ${name} <- ${url}`);
        const started = Date.now();
        const metaRes = expectFetch(yield {
            type: StepType.NET_FETCH,
            url,
            headers: { 'User-Agent': 'cts/' + version, Accept: 'application/json', ...npmAuthHeaders(url, cfg) },
            timeout: this.cfg.requestTimeout,
            onProgress,
        });
        if (metaRes.status < 200 || metaRes.status >= 300) {
            throw err(ErrorKind.NetworkError, `HTTP ${metaRes.status} fetching npm meta ${url}`);
        }
        const body = metaRes.body;
        log.debug('npm', () => `fetched meta ${name} ${fmtBytes(body.byteLength)} in ${Date.now() - started}ms`);
        const meta = safeParse<NpmMeta>(engine.decodeString(body));
        this.metaMem.set(name, meta);
        yield { type: StepType.FS_ENSURE_DIR, path: dirname(cacheFile) };
        // Cache the raw response bytes verbatim — avoids re-serializing the
        // whole (often multi-MB) metadata object just to persist it.
        yield { type: StepType.FS_WRITE_BYTES, path: cacheFile, data: body };
        yield { type: StepType.FS_WRITE_TEXT, path: cacheTs, text: String(Date.now()) };
    }

    /** Fetch+extract registry tarball only — dep walks stay outside the FLOW key. */
    private *installPackageBody(name: string, ver: string, dir: string, onProgress?: ProgressCallback): Flow<void> {
        if (fs.exists(joinPaths(dir, 'package.json'))) return;
        const meta = yield* this.fetchMeta(name, onProgress);
        if (fs.exists(joinPaths(dir, 'package.json'))) return;
        const dist = meta.versions[ver]?.dist;
        const tarball = dist?.tarball;
        if (!tarball) throw err(ErrorKind.VersionNotFound, `Version ${ver} not found for ${name}`);
        log.debug('npm', () => `fetch tarball ${name}@${ver} <- ${tarball}`);
        const fetchStarted = Date.now();
        const tarRes = expectFetch(yield { type: StepType.NET_FETCH, url: tarball, headers: npmAuthHeaders(tarball, this.getNpmCfg()), timeout: this.cfg.requestTimeout, onProgress });
        if (tarRes.status < 200 || tarRes.status >= 300) {
            throw err(ErrorKind.NetworkError, `HTTP ${tarRes.status} fetching tarball ${tarball}`);
        }
        const body = tarRes.body;
        log.debug('npm', () => `fetched tarball ${name}@${ver} ${fmtBytes(body.byteLength)} in ${Date.now() - fetchStarted}ms`);
        verifyRegistryTarball(body, dist, name, ver);
        if (fs.exists(joinPaths(dir, 'package.json'))) return;
        log.debug('npm', () => `extract ${name}@${ver} ${fmtBytes(body.byteLength)}`);
        const extractStarted = Date.now();
        const files = expectTarFiles(yield { type: StepType.ARCHIVE_UNTAR_GZ, data: body });
        let fileBytes = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (f?.type === 'file') fileBytes += f.size;
        }
        log.debug('npm', () => `extracted ${name}@${ver}: ${files.length} entries, ${fmtBytes(fileBytes)} in ${Date.now() - extractStarted}ms`);
        if (fs.exists(joinPaths(dir, 'package.json'))) return;
        yield { type: StepType.FS_ENSURE_DIR, path: dir };
        log.debug('npm', () => `write ${name}@${ver} -> ${dir}`);
        const writeStarted = Date.now();
        yield* this.writeArchive(dir, files);
        log.debug('npm', () => `wrote ${name}@${ver} in ${Date.now() - writeStarted}ms`);
        this.invalidateStoreListing(name);
        this.linkCacheAlias(name, dir);
        // Clear negative exists cache poisoned by mid-extract sibling resolves.
        clearNegativeCache();
        yield* this.indexInstalledBins(name, ver, dir);
    }

    /** Coalesce concurrent body extracts; prepare (deps) runs after the key settles. */
    private *installOnce(
        name: string,
        ver: string,
        dir: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
        yield {
            type: StepType.FLOW,
            key: `npm-install:${name}@${ver}`,
            flow: this.installPackageBody(name, ver, dir, onProgress),
        };
        yield* this.prepareInstalledPackage(name, ver, dir, onProgress, cyclePath);
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

    private *installDependencies(
        name: string,
        ver: string,
        dir: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
        // Always link deps into the store package. Flat store + realpath require a
        // complete package-local node_modules; gating on persistLock left packages
        // extracted by `cno run` permanently incomplete.
        const key = `${name}@${ver}`;
        if (this.dependenciesChecked.has(key)) return;

        const pkg = readPkg(dir);
        const deps = pkg?.dependencies;
        if (!deps) {
            this.dependenciesChecked.add(key);
            return;
        }
        // Names also listed in optionalDependencies are installed as optional only.
        const optional = pkg?.optionalDependencies;
        const required: Record<string, string> = Object.create(null);
        for (const depName in deps) {
            if (optional && Object.prototype.hasOwnProperty.call(optional, depName)) continue;
            required[depName] = deps[depName]!;
        }
        const depNames = recordKeysForLog(required);
        if (!depNames) {
            this.dependenciesChecked.add(key);
            return;
        }
        log.debug('npm', () => `deps for ${key}: ${depNames}`);
        const flows: Flow<void>[] = [];
        for (const depName in required) {
            flows.push(this.installDependency(dir, name, ver, depName, required[depName]!, onProgress, cyclePath));
        }
        yield { type: StepType.FLOW_ALL, flows, concurrency: this.packageInstallConcurrency() };
        // Only after a full successful walk — a mid-flight github: failure must retry.
        this.dependenciesChecked.add(key);
    }

    private *installDependency(
        parentDir: string,
        parentName: string,
        parentVer: string,
        name: string,
        range: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
        assertNpmPackageName(name);
        // Fast path: parent already has a satisfying link (prior install).
        const existing = this.readLinkedDepDir(parentDir, name);
        if (existing) {
            const pkg = readPkg(existing);
            if (pkg && localPackageMatchesRange(pkg.version, range)) {
                const ver = pkg.version ?? range;
                yield* this.prepareInstalledPackage(name, ver, existing, onProgress, cyclePath);
                this.linkDependency(parentDir, name, existing);
                return;
            }
        }
        const dep = yield* this.ensureInstalled(name, range, `npm:${parentName}@${parentVer}`, onProgress, cyclePath);
        this.linkDependency(parentDir, name, dep.dir);
    }

    /**
     * peerDependencies are not on the static import graph. Flat store packages
     * resolve via realpath, so peers must be linked under the package that
     * declared them (same as dependencies). Optional peers never fail install.
     */
    private *installPeerDeps(
        dir: string,
        parentName: string,
        parentVer: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
        const pkg = readPkg(dir);
        const peers = pkg?.peerDependencies;
        if (!peers) return;
        const meta = (pkg as { peerDependenciesMeta?: Record<string, { optional?: boolean }> })
            ?.peerDependenciesMeta;
        const peerNames = recordKeysForLog(peers);
        if (!peerNames) return;
        log.debug('npm', () => `peers for ${parentName}@${parentVer}: ${peerNames}`);
        const flows: Flow<void>[] = [];
        for (const peerName in peers) {
            const range = peers[peerName]!;
            const optional = meta?.[peerName]?.optional === true;
            flows.push(this.installPeerDependency(
                dir, parentName, parentVer, peerName, range, optional, onProgress, cyclePath,
            ));
        }
        yield { type: StepType.FLOW_ALL, flows, concurrency: this.packageInstallConcurrency() };
    }

    private *installPeerDependency(
        parentDir: string,
        parentName: string,
        parentVer: string,
        name: string,
        range: string,
        optional: boolean,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
        if (!isValidNpmPackageName(name)) return;
        // Optional peers: only link if already in the store — never fetch new trees.
        if (optional) {
            // Store-scoped only: findLocal() would search cwd() and link a
            // project's node_modules into the shared store. Range must match.
            const linked = this.readLinkedDepDir(parentDir, name);
            const pkg = linked ? readPkg(linked) : null;
            const local = (linked && localPackageMatchesRange(pkg?.version, range) ? linked : null)
                ?? this.findCachedPackageMatching(name, range);
            if (local) this.linkDependency(parentDir, name, local);
            return;
        }
        try {
            const dep = yield* this.ensureInstalled(name, range, `npm:${parentName}@${parentVer}`, onProgress, cyclePath);
            this.linkDependency(parentDir, name, dep.dir);
        } catch (e) {
            // Unmet required peers are warnings in npm; do not fail the install tree.
            log.debug('npm', () => `peer skipped: ${name} (${e instanceof Error ? e.message : String(e)})`);
            const local = this.findCachedPackageMatching(name, range);
            if (local) this.linkDependency(parentDir, name, local);
        }
    }

    /** Prefer an already-extracted store package that satisfies `range`. */
    private findCachedPackageMatching(name: string, range: string): string | null {
        if (!isValidNpmPackageName(name)) return null;
        // URL/github ranges pin a dist; only ensureInstalledFromTarballUrl may hit them.
        if (isOpaqueVersionRange(range)) return null;
        const locked = this.lockedVersionForRange(name, range);
        if (locked && !isUrlStoreVersion(locked)) {
            const dir = joinPaths(this.cacheDir, `${name}@${locked}`);
            if (fs.exists(joinPaths(dir, 'package.json'))) return dir;
        }
        const norm = stripLeadingV(range);
        if (isExactSemver(norm)) {
            const dir = joinPaths(this.cacheDir, `${name}@${norm}`);
            if (fs.exists(joinPaths(dir, 'package.json'))) return dir;
        }
        // Match among flat-store versions without registry meta (warm re-cache).
        // Skip URL-tagged dirs so a github pin cannot satisfy ^1.0.0 by accident.
        const versions = this.listStoreVersions(name).filter(v => !isUrlStoreVersion(v));
        if (versions.length > 0) {
            const matched = (!norm || norm === 'latest' || norm === '*')
                ? latestVersion(versions)
                : (matchLatestVersion(versions, norm) ?? (versions.includes(norm) ? norm : null));
            if (matched) {
                const dir = joinPaths(this.cacheDir, `${name}@${matched}`);
                if (fs.exists(joinPaths(dir, 'package.json'))) return dir;
            }
        }
        const alias = joinPaths(this.cacheDir, name);
        try {
            if (fs.exists(joinPaths(alias, 'package.json'))) {
                const pkg = readPkg(alias);
                if (localPackageMatchesRange(pkg?.version, range)) return fs.realpath(alias);
            }
        } catch {}
        return null;
    }

    /** Absolute dir linked at parent/node_modules/name, if any. */
    private readLinkedDepDir(parentDir: string, depName: string): string | null {
        if (!isValidNpmPackageName(depName)) return null;
        const target = joinPaths(parentDir, 'node_modules', depName);
        try {
            if (!fs.exists(joinPaths(target, 'package.json')) && !fs.exists(target)) return null;
            try {
                return fs.realpath(target);
            } catch {
                return target;
            }
        } catch {
            return null;
        }
    }

    /** Versions present as `<cache>/npm/<name>@<ver>` (scoped under scope dir). */
    private listStoreVersions(name: string): string[] {
        if (!isValidNpmPackageName(name)) return [];
        const hit = this.storeVersionsCache.get(name);
        // [] is a valid negative listing — do not re-readdir every miss.
        if (hit !== undefined) return hit;
        const versions: string[] = [];
        try {
            if (name.startsWith('@')) {
                const slash = name.indexOf('/');
                if (slash > 0) {
                    const scope = name.slice(0, slash);
                    const leaf = name.slice(slash + 1);
                    const prefix = `${leaf}@`;
                    for (const entry of this.listStoreScope(scope)) {
                        if (entry.startsWith(prefix)) {
                            const ver = entry.slice(prefix.length);
                            if (ver) versions.push(ver);
                        }
                    }
                }
            } else {
                const prefix = `${name}@`;
                for (const entry of this.listStoreRoot()) {
                    if (entry.startsWith(prefix)) {
                        const ver = entry.slice(prefix.length);
                        if (ver && !ver.includes('/')) versions.push(ver);
                    }
                }
            }
        } catch {
            // store missing / unreadable
        }
        this.storeVersionsCache.set(name, versions);
        return versions;
    }

    private listStoreRoot(): string[] {
        if (this.storeRootListing) return this.storeRootListing;
        try {
            this.storeRootListing = fs.readdir(this.cacheDir);
        } catch {
            this.storeRootListing = [];
        }
        return this.storeRootListing;
    }

    private listStoreScope(scope: string): string[] {
        const hit = this.storeScopeListing.get(scope);
        if (hit !== undefined) return hit;
        let listing: string[] = [];
        try {
            listing = fs.readdir(joinPaths(this.cacheDir, scope));
        } catch {
            listing = [];
        }
        this.storeScopeListing.set(scope, listing);
        return listing;
    }

    /** Drop cached readdir after a package is written into the store. */
    private invalidateStoreListing(name?: string): void {
        this.storeRootListing = null;
        this.storeScopeListing.clear();
        if (name) this.storeVersionsCache.delete(name);
        else this.storeVersionsCache.clear();
    }

    /** Try to install each optionalDependency. Failures are non-fatal (platform mismatch, etc). */
    private *installOptionalDeps(
        dir: string,
        onProgress?: ProgressCallback,
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
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
            flows.push(this.installOptionalDependency(
                dir, depName, depRange, osName, cpuName, abiName, onProgress, cyclePath,
            ));
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
        cyclePath: ReadonlySet<string> = EMPTY_CYCLE,
    ): Flow<void> {
        if (!isValidNpmPackageName(name)) return;
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
                yield* this.installOnce(name, ver, depDir, onProgress, cyclePath);
                log.debug('npm', () => `optional dep installed: ${name}@${ver}`);
            } else {
                yield* this.prepareInstalledPackage(name, ver, depDir, onProgress, cyclePath);
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
        if (!isValidNpmPackageName(depName)) return;
        const target = joinPaths(parentDir, 'node_modules', depName);
        try {
            if (!fs.exists(joinPaths(depDir, 'package.json'))) return;
            // Keep only when the occupant already is the intended package.
            // Wrong-version soft links used to stick forever (package.json present).
            if (!this.isLinkedDepTarget(target, depDir)) {
                try {
                    const st = fs.lstat(target);
                    // Soft install links only: never recursively wipe hard-materialized dirs.
                    if (st.isSymbolicLink || !st.isDirectory) fs.unlink(target);
                } catch {}
                if (!fs.exists(joinPaths(target, 'package.json'))) {
                    ensureDir(dirname(target));
                    symlinkDir(depDir, target);
                }
            }
            this.linkDependencyBins(parentDir, depDir);
        } catch (e) {
            log.debug('npm', () => `dependency link skipped: ${depName} -> ${target} (${e instanceof Error ? e.message : String(e)})`);
        }
    }

    /** True when target already resolves to depDir (or same name@version identity). */
    private isLinkedDepTarget(target: string, depDir: string): boolean {
        try {
            if (!fs.exists(joinPaths(target, 'package.json'))) return false;
            try {
                if (normalizePath(fs.realpath(target)) === normalizePath(depDir)) return true;
            } catch {
                return false;
            }
            // Prefer store path identity — URL-tagged dirs differ by +u… even when
            // package.json.version is the same base semver.
            const wantId = this.storePackageId(depDir);
            const haveId = this.storePackageId(target);
            if (wantId && haveId) {
                return wantId.name === haveId.name && wantId.version === haveId.version;
            }
            // Hard-materialized real dirs outside the store: package.json identity.
            const want = readPkg(depDir);
            const have = readPkg(target);
            if (want?.version && have?.version && want.version === have.version) {
                const wantName = want.name ?? '';
                const haveName = have.name ?? '';
                return !wantName || !haveName || wantName === haveName;
            }
            return false;
        } catch {
            return false;
        }
    }

    /** name@version from store path when under cacheDir; else null. */
    private storePackageId(dir: string): { name: string; version: string } | null {
        const root = normalizePath(this.cacheDir);
        const norm = normalizePath(dir);
        if (!norm.startsWith(root + '/') && norm !== root) return null;
        const rel = norm.slice(root.length + 1);
        const at = rel.startsWith('@') ? rel.indexOf('@', 1) : rel.indexOf('@');
        if (at <= 0) return null;
        const name = rel.slice(0, at);
        const version = rel.slice(at + 1);
        if (!isValidNpmPackageName(name) || !isSafeStoreVersionSegment(version)) return null;
        return { name, version };
    }

    private linkCacheAlias(name: string, dir: string): void {
        if (!isValidNpmPackageName(name)) return;
        const target = joinPaths(this.cacheDir, name);
        try {
            if (target === dir) return;
            // Soft alias to the latest-written store package. Replace when the
            // occupant already points elsewhere (stale version) or is broken.
            try {
                const st = fs.lstat(target);
                if (st.isSymbolicLink) {
                    try {
                        if (normalizePath(fs.realpath(target)) === normalizePath(dir)) return;
                    } catch {}
                    fs.unlink(target);
                } else if (st.isDirectory && fs.exists(joinPaths(target, 'package.json'))) {
                    // Real dir alias (legacy merge layout) — leave alone.
                    return;
                } else if (!st.isDirectory) {
                    fs.unlink(target);
                }
            } catch {
                // target missing
            }
            if (fs.exists(target)) return;
            ensureDir(dirname(target));
            symlinkDir(dir, target);
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
            const source = resolvePackageBinPath(depDir, relPath);
            if (!source) continue;
            const target = joinPaths(binDir, binName);
            try {
                let same = false;
                try {
                    same = normalizePath(fs.realpath(target)) === normalizePath(fs.realpath(source));
                } catch {
                    same = false;
                }
                if (same) continue;
                // Stale/wrong bin link from a prior package version — replace.
                try {
                    const st = fs.lstat(target);
                    if (st.isSymbolicLink || !st.isDirectory) fs.unlink(target);
                } catch {}
                if (fs.exists(target)) continue;
                ensureDir(binDir);
                symlinkFile(source, target);
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
            const absPath = resolvePackageBinPath(dir, relPath);
            if (absPath) {
                this.cfg.lockStore?.addBin(binName, absPath, spec);
                log.debug('bin', () => `indexed: ${binName} → ${absPath} (${spec})`);
            }
        }
    }

    // package.json last: earlier = false "installed" + poisoned negative cache.
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
