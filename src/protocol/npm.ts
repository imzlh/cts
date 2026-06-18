// protocol/npm.ts - npm registry handler

import type { RuntimeConfig, ModuleInfo } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { StepType, type Flow, type TarFile, type ProgressCallback } from '../flow';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { readText, resolveFile } from '../utils/io';
declare const URL: any;
import { matchLatestVersion, compareVersions, safeParse } from '../utils/misc';
import { detectFormat, readPkgFresh, createCtx, resolveSubpath, resolveImports, getBinMap } from '../pkg';
import { err, ErrorKind } from '../errors';
import { log } from '../utils/log';
import { isatty } from '../utils/progress';
import { uname } from '../utils/index';
import { version } from '../../package.json';

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
    try { const p = joinPaths(String(os.cwd).replace(/\\/g, '/'), '.npmrc'); if (fs.exists(p)) parse(readText(p), true); } catch {}
    try { const p = joinPaths(String(os.homeDir ?? '/root').replace(/\\/g, '/'), '.npmrc'); if (fs.exists(p)) parse(readText(p), false); } catch {}
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
    versions: Record<string, { version: string; dist: { tarball: string } }>;
    'dist-tags': Record<string, string>;
}

export class NpmHandler implements ProtocolHandler {
    readonly protocols = ['npm'];
    private readonly cacheDir: string;
    private npmCfg: NpmConfig | null = null;
    private readonly verCache = new Map<string, string>();
    private readonly pendingPostinstall: Array<{ name: string; version: string; dir: string; script: string }> = [];

    constructor(private readonly cfg: RuntimeConfig) {
        this.cacheDir = joinPaths(cfg.cacheDir, 'npm');
    }

    /** Clear version resolution cache */
    clearCache(): void {
        this.verCache.clear();
        this.npmCfg = null;
    }

    /** Drain pending postinstall scripts (called by runtime after scan). */
    drainPostinstall(): Array<{ name: string; version: string; dir: string; script: string }> {
        const scripts = this.pendingPostinstall.splice(0);
        return scripts;
    }

    *resolve(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const forceCjs = attr?.cjs === true || (attr?.type !== 'module' && !parent.startsWith('npm:'));
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('npm:')) {
            return yield* this.resolveRelative(spec, parent, forceCjs, onProgress);
        }
        if (spec === '.' && parent.startsWith('npm:')) {
            return yield* this.resolveRelative('.', parent, forceCjs, onProgress);
        }
        if (spec.startsWith('#') && parent.startsWith('npm:')) {
            return yield* this.resolveSubpathImport(spec, parent, forceCjs, onProgress);
        }
        const { name, version: range, subpath } = parseNpmSpec(spec);
        const pkg = yield* this.ensureInstalled(name, range, parent, onProgress);
        return this.resolvePkg(pkg.dir, pkg.resolvedVer, name, subpath, forceCjs);
    }

    /**
     * Resolve a binary name to its absolute path.
     * Priority: local node_modules/.bin > lock bin index.
     */
    resolveBin(name: string, cwd: string): string | null {
        if (name.startsWith('/') || name.startsWith('.') || name.includes('/')) return null;

        // 1. Local node_modules/.bin (highest priority)
        const local = this.findLocalBin(name, cwd);
        if (local) return local;

        // 2. Lock bin index
        const lockBin = this.cfg.lockStore?.getBin(name);
        if (lockBin) return lockBin.path;

        return null;
    }

    private findLocalBin(name: string, cwd: string): string | null {
        let dir = cwd;
        const isWin = uname.sysname.includes('Windows');
        const root = isWin ? dir.split(':')[0] + ':/' : '/';
        while (dir !== root) {
            const base = joinPaths(dir, 'node_modules', '.bin', name);
            if (fs.exists(base)) return base;
            if (isWin) {
                for (const ext of ['.cmd', '.bat']) {
                    const c = base + ext;
                    if (fs.exists(c)) return c;
                }
            }
            const up = dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        return null;
    }

    localPath(specPath: string): string {
        const { name, version, subpath } = parseNpmSpec(specPath);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${version}`);
        if (!fs.exists(pkgDir)) throw err(ErrorKind.ModuleNotFound, `Package not in cache: ${specPath}`);
        const ctx = createCtx(pkgDir);
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkgDir}`);
        const localPath = resolveSubpath(ctx, subpath || '.');
        if (!localPath) throw err(ErrorKind.ModuleNotFound, `Cannot resolve path for ${specPath}`);
        return localPath;
    }

    private static specPath(name: string, version: string, subpath: string): string {
        return `npm:${name}@${version}` + (subpath ? `/${subpath}` : '');
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
            let parentLocal = resolveSubpath(ctx, subpath);
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
        const relToDir = normalizePath(resolvedLocal.slice(pkg.dir.length + 1));
        return {
            specPath: NpmHandler.specPath(name, pkg.resolvedVer, relToDir),
            localPath: resolvedLocal,
            format: detectFormat(resolvedLocal),
            fileKind: guessFileKind(resolvedLocal),
        };
    }

    private *resolveSubpathImport(spec: string, parent: string, forceCjs: boolean, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const { name, version } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent, onProgress);
        const ctx = createCtx(pkg.dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);
        const localPath = resolveImports(ctx, spec);
        if (!localPath) throw err(ErrorKind.ModuleNotFound, `Cannot resolve "${spec}" in ${name}@${pkg.resolvedVer} - not found in package.json "imports"`);
        return {
            specPath: NpmHandler.specPath(name, pkg.resolvedVer, localPath.slice(pkg.dir.length + 1)),
            localPath,
            format: detectFormat(localPath),
            fileKind: guessFileKind(localPath),
        };
    }

    private resolvePkg(dir: string, ver: string, name: string, subpath: string, forceCjs: boolean): ModuleInfo {
        const ctx = createCtx(dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${dir}`);
        const localPath = resolveSubpath(ctx, subpath);
        if (!localPath) {
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
        return {
            specPath: NpmHandler.specPath(name, ver, subpath),
            localPath,
            format: detectFormat(localPath),
            fileKind: guessFileKind(localPath),
        };
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

    private findLocal(name: string, parent?: string): string | null {
        const search: string[] = [];
        if (parent) {
            let startDir = parent.startsWith('npm:') ? this.cacheDir : dirname(parent);
            const root = uname.sysname.includes('Windows') ? startDir.split(':')[0] + ':/' : '/';
            while (startDir && startDir !== root) {
                search.push(joinPaths(startDir, 'node_modules'));
                const up = dirname(startDir);
                if (up === startDir) break;
                startDir = up;
            }
        }
        search.push(joinPaths(String(os.cwd).replace(/\\/g, '/'), 'node_modules'));
        for (const sp of search) {
            const p = joinPaths(sp, name);
            try {
                if (fs.stat(p).isDirectory && fs.exists(joinPaths(p, 'package.json'))) {
                    this.indexLocalBins(p, name);
                    return p;
                }
            } catch {}
        }
        return null;
    }

    private indexLocalBins(pkgDir: string, name: string): void {
        const pkg = readPkgFresh(pkgDir);
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
        const local = this.findLocal(name, parent);
        if (local) {
            const pkg = readPkgFresh(local);
            return { dir: local, resolvedVer: pkg?.version ?? version };
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
        const pkg = readPkgFresh(dir);
        const postinstall = pkg?.scripts?.postinstall;
        if (postinstall && typeof postinstall === 'string' && postinstall.trim()) {
            this.pendingPostinstall.push({ name, version: ver, dir, script: postinstall });
            log.debug('npm', () => `postinstall queued: ${name}@${ver}`);
        }
    }

    /** Try to install each optionalDependency. Failures are non-fatal (platform mismatch, etc). */
    private *installOptionalDeps(dir: string, onProgress?: ProgressCallback): Flow<void> {
        const pkg = readPkgFresh(dir);
        if (!pkg?.optionalDependencies) return;
        const opts = Object.entries(pkg.optionalDependencies);
        if (!opts.length) return;
        log.debug('npm', () => `optional deps for ${pkg.name}: ${opts.map(([n]) => n).join(', ')}`);
        for (const [depName, depRange] of opts) {
            try {
                const exactVer = yield* this.resolveVersion(depName, depRange, onProgress);
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
        const pkg = readPkgFresh(dir);
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

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
