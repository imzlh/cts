// protocol/npm.ts - npm registry handler

import type { RuntimeConfig, ModuleInfo } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { StepType, type Flow, type TarFile } from '../flow';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { readText, resolveFile } from '../utils/io';
declare const URL: any;
import { matchLatestVersion, compareVersions, safeParse } from '../utils/misc';
import { detectFormat, readPkgFresh, createCtx, resolveSubpath, resolveImports } from '../pkg';
import { err, ErrorKind } from '../errors';
import { log } from '../utils/log';
import { isatty } from '../utils/progress';
import { fs, os, uname, engine } from '../utils/index';
import { version } from '../../package.json';

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
    try { const p = joinPaths(os.cwd, '.npmrc'); if (fs.exists(p)) parse(readText(p), true); } catch {}
    try { const p = joinPaths(os.homeDir ?? '/root', '.npmrc'); if (fs.exists(p)) parse(readText(p), false); } catch {}
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

    constructor(private readonly cfg: RuntimeConfig) {
        this.cacheDir = joinPaths(cfg.cacheDir, 'npm');
    }

    /** Clear version resolution cache */
    clearCache(): void {
        this.verCache.clear();
        this.npmCfg = null;
    }

    *resolve(spec: string, parent: string, attr?: Record<string, any>): Flow<ModuleInfo> {
        const forceCjs = attr?.cjs === true || (attr?.type !== 'module' && !parent.startsWith('npm:'));
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('npm:')) {
            return yield* this.resolveRelative(spec, parent, forceCjs);
        }
        if (spec === '.' && parent.startsWith('npm:')) {
            return yield* this.resolveRelative('.', parent, forceCjs);
        }
        if (spec.startsWith('#') && parent.startsWith('npm:')) {
            return yield* this.resolveSubpathImport(spec, parent, forceCjs);
        }
        const { name, version: range, subpath } = parseNpmSpec(spec);
        const pkg = yield* this.ensureInstalled(name, range, parent);
        return this.resolvePkg(pkg.dir, pkg.resolvedVer, name, subpath, forceCjs);
    }

    localPath(specPath: string): string {
        const match = specPath.match(/^npm:([^@]+)@([^/]+)(\/.*)?$/);
        if (!match) throw err(ErrorKind.InvalidSpecifier, `Invalid npm specPath: ${specPath}`);
        const [, name, version, subpath] = match;
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

    private *resolveRelative(spec: string, parent: string, forceCjs: boolean): Flow<ModuleInfo> {
        const { name, version, subpath } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent);
        const ctx = createCtx(pkg.dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);
        let parentLocal = resolveSubpath(ctx, subpath || '.');
        if (!parentLocal) {
            const targetName = subpath.split('/').pop()!;
            parentLocal = this.findFileByBasename(pkg.dir, targetName, subpath);
        }
        if (!parentLocal) throw err(ErrorKind.ModuleNotFound, `Cannot resolve parent "${subpath || '.'}" in ${name}@${pkg.resolvedVer}`);
        const targetLocal = normalizePath(joinPaths(dirname(parentLocal), spec));
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

    private *resolveSubpathImport(spec: string, parent: string, forceCjs: boolean): Flow<ModuleInfo> {
        const { name, version } = parseNpmSpec(parent);
        const pkg = yield* this.ensureInstalled(name, version, parent);
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
            const pkg = ctx.pkg;
            const hint = pkg.exports
                ? `(exports: ${JSON.stringify(pkg.exports)})`
                : pkg.main ? `(main: "${pkg.main}")` : '(no main field)';
            throw err(ErrorKind.ModuleNotFound,
                `Cannot resolve "${subpath || '.'}" in ${name}@${ver} - ${hint}\n` +
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
        search.push(joinPaths(os.cwd, 'node_modules'));
        for (const sp of search) {
            const p = joinPaths(sp, name);
            try { if (fs.stat(p).isDirectory && fs.exists(joinPaths(p, 'package.json'))) return p; } catch {}
        }
        return null;
    }

    private getNpmCfg(): NpmConfig {
        return (this.npmCfg ??= loadNpmConfig());
    }

    private *ensureInstalled(name: string, version: string, parent?: string): Flow<{ dir: string; resolvedVer: string }> {
        const local = this.findLocal(name, parent);
        if (local) {
            const pkg = readPkgFresh(local);
            return { dir: local, resolvedVer: pkg?.version ?? version };
        }
        const exactVer = yield* this.resolveVersion(name, version);
        const pkgDir = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        const exists = yield { type: StepType.FS_EXISTS, path: pkgDir };
        if (!exists) {
            if (!this.cfg.silent && !isatty) log.download(`${name}@${exactVer}`);
            yield* this.install(name, exactVer, pkgDir);
        }
        return { dir: pkgDir, resolvedVer: exactVer };
    }

    private *resolveVersion(name: string, range: string): Flow<string> {
        const key = `${name}@${range}`;
        if (this.verCache.has(key)) return this.verCache.get(key)!;
        const meta = yield* this.fetchMeta(name);
        const tags = meta['dist-tags'] ?? {};
        let resolved: string;
        if (!range || range === 'latest') resolved = tags.latest ?? this.highestVersion(meta);
        else if (tags[range]) resolved = tags[range]!;
        else if (/^\d+\.\d+\.\d+/.test(range) && meta.versions[range]) resolved = range;
        else resolved = matchLatestVersion(Object.keys(meta.versions), range) ?? tags.latest ?? this.highestVersion(meta);
        this.verCache.set(key, resolved);
        return resolved;
    }

    private *fetchMeta(name: string): Flow<NpmMeta> {
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
        const { body } = yield {
            type: StepType.NET_FETCH,
            url: `${registry}/${name}`,
            headers: { 'User-Agent': 'cts/' + version, Accept: 'application/json' },
            timeout: this.cfg.requestTimeout,
        };
        const meta = safeParse<NpmMeta>(engine.decodeString(body));
        yield { type: StepType.FS_ENSURE_DIR, path: dirname(cacheFile) };
        yield { type: StepType.FS_WRITE_TEXT, path: cacheFile, text: JSON.stringify(meta, null, 2) };
        yield { type: StepType.FS_WRITE_TEXT, path: cacheTs, text: String(Date.now()) };
        return meta;
    }

    private *install(name: string, ver: string, dir: string): Flow<void> {
        const meta = yield* this.fetchMeta(name);
        const tarball = meta.versions[ver]?.dist.tarball;
        if (!tarball) throw err(ErrorKind.VersionNotFound, `Version ${ver} not found for ${name}`);
        const { body } = yield { type: StepType.NET_FETCH, url: tarball, timeout: this.cfg.requestTimeout };
        const files = (yield { type: StepType.ARCHIVE_UNTAR_GZ, data: body }) as TarFile[];
        yield { type: StepType.FS_ENSURE_DIR, path: dir };
        yield* this.writeArchive(dir, files);
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
