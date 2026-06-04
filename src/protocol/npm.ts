// protocol/npm.ts 鈥?npm registry handler

import type { RuntimeConfig, ModuleInfo, PackageJson } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { ensureDir, readText, writeText, resolveFile } from '../utils/io';
import { fetchAsync, fetchBytes, type ProgressCallback } from '@cnojs/http/client';
// URL polyfill 鈥?CNO runtime provides global URL
declare const URL: any;
import { unTarGz, matchLatestVersion, compareVersions, safeParse, errMsg } from '../utils/misc';
import { detectFormat, readPkgFresh, createCtx, resolveSubpath, resolveImports } from '../pkg';
import { err, ErrorKind } from '../errors';
import { log } from '../utils/log';
import { isatty } from '../utils/progress';
import { fs, os, uname, engine } from '../utils/index';
import { version } from '../../package.json';

// ---------------------------------------------------------------------------
// npm config (registry, auth)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// specifier parsing
// ---------------------------------------------------------------------------

interface ParsedNpmSpec { name: string; version: string; subpath: string }

function parseNpmSpec(raw: string): ParsedNpmSpec {
    let rest = raw.startsWith('npm:') ? raw.slice(4).replace(/^\//, '') : raw;
    // Strip leading slashes to handle npm://@scope/pkg etc.
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

// ---------------------------------------------------------------------------
// npm metadata types
// ---------------------------------------------------------------------------

interface NpmMeta {
    versions: Record<string, { version: string; dist: { tarball: string } }>;
    'dist-tags': Record<string, string>;
}

// ---------------------------------------------------------------------------
// NpmHandler
// ---------------------------------------------------------------------------

export class NpmHandler implements ProtocolHandler {
    readonly protocols = ['npm'];
    private readonly cacheDir: string;
    private npmCfg: NpmConfig | null = null;
    // version cache: name@range 鈫?resolved exact version
    private readonly verCache = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {
        this.cacheDir = joinPaths(cfg.cacheDir, 'npm');
    }

    private fetchOptions(headers?: Record<string, string>) {
        return {
            timeout: this.cfg.requestTimeout,
            ...(headers ? { headers } : {}),
        };
    }

    private fetchBytesSync(url: string, headers?: Record<string, string>): Uint8Array {
        return fetchBytes(url, undefined, this.fetchOptions(headers));
    }

    resolve(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        const forceCjs = attr?.cjs === true || (attr?.type !== 'module' && !parent.startsWith('npm:'));
        // Relative import within an npm module
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('npm:')) {
            return this.resolveRelative(spec, parent, forceCjs);
        }
        // require('.') means "the main entry of the current package"
        if (spec === '.' && parent.startsWith('npm:')) {
            return this.resolveRelative('.', parent, forceCjs);
        }
        // Subpath imports (e.g. "#minpath") 鈥?resolve within the parent package
        if (spec.startsWith('#') && parent.startsWith('npm:')) {
            return this.resolveSubpathImport(spec, parent, forceCjs);
        }
        const { name, version, subpath } = parseNpmSpec(spec);
        const pkg = this.ensureInstalled(name, version, parent);
        return this.resolvePkg(pkg.dir, pkg.resolvedVer, name, subpath, forceCjs);
    }

    localPath(specPath: string): string {
        const { name, version, subpath } = parseNpmSpec(specPath);
        // Resolve the actual installed version 鈥?the spec may contain a range
        // like "latest" that doesn't match the on-disk directory name.
        const exactVer = this.resolveVersion(name, version);
        const dir = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        const ctx = createCtx(dir);
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `Package not installed: ${specPath}`);
        return resolveSubpath(ctx, subpath) ?? (() => { throw err(ErrorKind.ModuleNotFound, `Cannot resolve ${subpath} in ${name}`); })();
    }

    // ---------------------------------------------------------------------------

    /** Build a canonical npm specPath: npm:name@version/subpath */
    private static specPath(name: string, version: string, subpath: string): string {
        return `npm:${name}@${version}` + (subpath ? `/${subpath}` : '');
    }

    private resolveRelative(spec: string, parent: string, forceCjs: boolean): ModuleInfo {
        const { name, version, subpath } = parseNpmSpec(parent);
        // Use ensureInstalled to resolve the actual installed directory.
        // The version from the parent specifier may be a range (e.g. "latest",
        // "^1.0.0") that doesn't match the actual directory name on disk.
        const pkg = this.ensureInstalled(name, version, parent);
        const dir = pkg.dir;
        const ctx = createCtx(dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${dir}`);

        // Resolve the parent's actual localPath on disk.
        let parentLocal = resolveSubpath(ctx, subpath || '.');
        if (!parentLocal) {
            // Fallback: subpath may be a Deno-rewritten path (e.g. "b/index.js"
            // mapping to "lib/index.js"). Search the package directory for a file
            // with the same basename and compatible extension.
            const targetName = subpath.split('/').pop()!;
            parentLocal = this.findFileByBasename(dir, targetName, subpath);
        }
        if (!parentLocal) throw err(ErrorKind.ModuleNotFound, `Cannot resolve parent "${subpath || '.'}" in ${name}@${pkg.resolvedVer}`);

        const targetLocal = normalizePath(joinPaths(dirname(parentLocal), spec));
        // Verify the target file exists
        const resolvedLocal = resolveFile(targetLocal);
        if (!resolvedLocal) throw err(ErrorKind.FileNotFound, `Cannot resolve "${spec}" from "${parent}": file not found at ${targetLocal}`);

        // Compute the subpath relative to pkgDir for the canonical specPath
        const relToDir = normalizePath(resolvedLocal.slice(dir.length + 1));
        return {
            specPath: NpmHandler.specPath(name, pkg.resolvedVer, relToDir),
            localPath: resolvedLocal,
            format: detectFormat(resolvedLocal),
            fileKind: guessFileKind(resolvedLocal),
        };
    }

    /** Resolve a subpath import ("#xxx") within the parent npm package. */
    private resolveSubpathImport(spec: string, parent: string, forceCjs: boolean): ModuleInfo {
        const { name, version } = parseNpmSpec(parent);
        const pkg = this.ensureInstalled(name, version, parent);
        const ctx = createCtx(pkg.dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);
        const localPath = resolveImports(ctx, spec);
        if (!localPath) throw err(ErrorKind.ModuleNotFound,
            `Cannot resolve "${spec}" in ${name}@${pkg.resolvedVer} 鈥?not found in package.json "imports"`);
        return {
            specPath: NpmHandler.specPath(name, pkg.resolvedVer, localPath.slice(pkg.dir.length + 1)),
            localPath,
            format: detectFormat(localPath),
            fileKind: guessFileKind(localPath),
        };
    }

    /** Find a file in dir matching basename, preferring paths that end with subpath's suffix. */
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
                        // Skip node_modules to avoid deep recursion
                        if (e !== 'node_modules') walk(p);
                    } else if (e === basename) {
                        results.push(p);
                    }
                } catch {}
            }
        };
        walk(dir);
        if (!results.length) return null;
        // Prefer result whose relative path ends with the subpath directory prefix
        if (subSuffix) {
            for (const r of results) {
                const rel = normalizePath(r.slice(dir.length + 1));
                if (rel.endsWith(subSuffix + '/' + basename)) return r;
            }
        }
        return results[0]!;
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
                `Cannot resolve "${subpath || '.'}" in ${name}@${ver} 鈥?${hint}\n` +
                `  The package may not expose a default entry point. ` +
                `Try importing a specific subpath like npm:${name}@${ver}/<file>`);
        }
        return {
            specPath: NpmHandler.specPath(name, ver, subpath),
            localPath,
            format: detectFormat(localPath),
            fileKind: guessFileKind(localPath),
        };
    }

    private ensureInstalled(name: string, version: string, parent?: string): { dir: string; resolvedVer: string } {
        // Check local node_modules first
        const local = this.findLocal(name, parent);
        if (local) {
            const pkg = readPkgFresh(local);
            return { dir: local, resolvedVer: pkg?.version ?? version };
        }

        // Check global cache
        const exactVer = this.resolveVersion(name, version);
        const pkgDir   = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        if (!fs.exists(pkgDir)) {
            if (!this.cfg.silent && !isatty) log.info(`馃摝 ${name}@${exactVer}`);
            this.install(name, exactVer, pkgDir);
        }
        return { dir: pkgDir, resolvedVer: exactVer };
    }

    private resolveVersion(name: string, range: string): string {
        const key = `${name}@${range}`;
        if (this.verCache.has(key)) return this.verCache.get(key)!;

        const meta = this.fetchMeta(name);
        const tags  = meta['dist-tags'] ?? {};
        let resolved: string;

        if (!range || range === 'latest') {
            resolved = tags.latest ?? this.highestVersion(meta);
        } else if (tags[range]) {
            resolved = tags[range]!;
        } else if (/^\d+\.\d+\.\d+/.test(range) && meta.versions[range]) {
            resolved = range;
        } else {
            resolved = matchLatestVersion(Object.keys(meta.versions), range)
                ?? tags.latest ?? this.highestVersion(meta);
        }

        this.verCache.set(key, resolved);
        return resolved;
    }

    private highestVersion(meta: NpmMeta): string {
        return Object.keys(meta.versions)
            .sort(compareVersions).at(-1)!;
    }

    private fetchMeta(name: string): NpmMeta {
        const cfg      = this.getNpmCfg();
        const registry = (name.startsWith('@') && cfg.scopeRegistries[name.split('/')[0]!])
            ? cfg.scopeRegistries[name.split('/')[0]!]!
            : cfg.registry;
        const cacheFile = joinPaths(this.cacheDir, name, 'meta.json');
        const cacheTs   = cacheFile + '.ts';
        if (fs.exists(cacheFile)) {
            try {
                const age = Date.now() - +(readText(cacheTs) || '0');
                if (age < 24 * 60 * 60 * 1000) return safeParse<NpmMeta>(readText(cacheFile));
            } catch {}
        }
        const body = this.fetchBytesSync(`${registry}/${name}`);
        const meta = safeParse<NpmMeta>(engine.decodeString(body as any));
        ensureDir(dirname(cacheFile));
        writeText(cacheFile, JSON.stringify(meta, null, 2));
        writeText(cacheTs, String(Date.now()));
        return meta;
    }

    private install(name: string, ver: string, dir: string): void {
        const meta    = this.fetchMeta(name);
        const tarball = meta.versions[ver]?.dist.tarball;
        if (!tarball) throw err(ErrorKind.VersionNotFound, `Version ${ver} not found for ${name}`);
        const body = this.fetchBytesSync(tarball);
        const files = unTarGz(body as any);
        ensureDir(dir);
        const seen = new Set<string>();
        for (const f of files) {
            let p = f.path;
            if (p.startsWith('package/')) p = p.slice(8);
            const target = joinPaths(dir, p);
            if (f.type === 'dir') { if (!seen.has(target)) { ensureDir(target); seen.add(target); } }
            else { const d = dirname(target); if (!seen.has(d)) { ensureDir(d); seen.add(d); } fs.writeFile(target, f.content as any); }
        }
    }

    private findLocal(name: string, parent?: string): string | null {
        const search: string[] = [];
        if (parent) {
            let startDir: string;
            if (parent.startsWith('npm:')) {
                // Parent is in the global cache (e.g. npm:lodash@4.17.21).
                // Look for sibling node_modules under the cache directory,
                // since npm hoists nested deps to the cache root.
                startDir = this.cacheDir;
            } else {
                startDir = dirname(parent);
            }
            let d = startDir;
            const root = uname.sysname.includes('Windows') ? d.split(':')[0] + ':/' : '/';
            while (d && d !== root) {
                search.push(joinPaths(d, 'node_modules'));
                const up = dirname(d); if (up === d) break; d = up;
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

    // -------------------------------------------------------------------------
    // async resolve 鈥?parallel precache path (uses fetchAsync, no engine.waitPromise)
    // -------------------------------------------------------------------------

    async resolveAsync(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        const forceCjs = attr?.cjs === true || (attr?.type !== 'module' && !parent.startsWith('npm:'));
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('npm:')) {
            return this.resolveRelativeAsync(spec, parent, forceCjs);
        }
        if (spec === '.' && parent.startsWith('npm:')) {
            return this.resolveRelativeAsync('.', parent, forceCjs);
        }
        if (spec.startsWith('#') && parent.startsWith('npm:')) {
            return this.resolveSubpathImportAsync(spec, parent, forceCjs);
        }
        const { name, version, subpath } = parseNpmSpec(spec);
        const pkg = await this.ensureInstalledAsync(name, version, parent, onProgress);
        return this.resolvePkg(pkg.dir, pkg.resolvedVer, name, subpath, forceCjs);
    }

    private async resolveRelativeAsync(spec: string, parent: string, forceCjs: boolean): Promise<ModuleInfo> {
        const { name, version, subpath } = parseNpmSpec(parent);
        const pkg = await this.ensureInstalledAsync(name, version, parent);
        const dir = pkg.dir;
        const ctx = createCtx(dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${dir}`);
        let parentLocal = resolveSubpath(ctx, subpath || '.');
        if (!parentLocal) {
            const targetName = subpath.split('/').pop()!;
            parentLocal = this.findFileByBasename(dir, targetName, subpath);
        }
        if (!parentLocal) throw err(ErrorKind.ModuleNotFound, `Cannot resolve parent "${subpath || '.'}" in ${name}@${pkg.resolvedVer}`);
        const targetLocal = normalizePath(joinPaths(dirname(parentLocal), spec));
        const resolvedLocal = resolveFile(targetLocal);
        if (!resolvedLocal) throw err(ErrorKind.FileNotFound, `Cannot resolve "${spec}" from "${parent}": file not found at ${targetLocal}`);
        const relToDir = normalizePath(resolvedLocal.slice(dir.length + 1));
        return {
            specPath: NpmHandler.specPath(name, pkg.resolvedVer, relToDir),
            localPath: resolvedLocal,
            format: detectFormat(resolvedLocal),
            fileKind: guessFileKind(resolvedLocal),
        };
    }

    private async resolveSubpathImportAsync(spec: string, parent: string, forceCjs: boolean): Promise<ModuleInfo> {
        const { name, version } = parseNpmSpec(parent);
        const pkg = await this.ensureInstalledAsync(name, version, parent);
        const ctx = createCtx(pkg.dir, { forceCjs });
        if (!ctx) throw err(ErrorKind.ModuleNotFound, `package.json not found in ${pkg.dir}`);
        const localPath = resolveImports(ctx, spec);
        if (!localPath) throw err(ErrorKind.ModuleNotFound,
            `Cannot resolve "${spec}" in ${name}@${pkg.resolvedVer} 鈥?not found in package.json "imports"`);
        return {
            specPath: NpmHandler.specPath(name, pkg.resolvedVer, localPath.slice(pkg.dir.length + 1)),
            localPath,
            format: detectFormat(localPath),
            fileKind: guessFileKind(localPath),
        };
    }

    private async ensureInstalledAsync(name: string, version: string, parent?: string, onProgress?: ProgressCallback): Promise<{ dir: string; resolvedVer: string }> {
        const local = this.findLocal(name, parent);
        if (local) {
            const pkg = readPkgFresh(local);
            return { dir: local, resolvedVer: pkg?.version ?? version };
        }
        const exactVer = await this.resolveVersionAsync(name, version);
        const pkgDir   = joinPaths(this.cacheDir, `${name}@${exactVer}`);
        if (!fs.exists(pkgDir)) {
            if (!this.cfg.silent && !isatty) log.info(`馃摝 ${name}@${exactVer}`);
            await this.installAsync(name, exactVer, pkgDir, onProgress);
        }
        return { dir: pkgDir, resolvedVer: exactVer };
    }

    private async resolveVersionAsync(name: string, range: string): Promise<string> {
        const key = `${name}@${range}`;
        if (this.verCache.has(key)) return this.verCache.get(key)!;
        const meta = await this.fetchMetaAsync(name);
        const tags  = meta['dist-tags'] ?? {};
        let resolved: string;
        if (!range || range === 'latest') {
            resolved = tags.latest ?? this.highestVersion(meta);
        } else if (tags[range]) {
            resolved = tags[range]!;
        } else if (/^\d+\.\d+\.\d+/.test(range) && meta.versions[range]) {
            resolved = range;
        } else {
            resolved = matchLatestVersion(Object.keys(meta.versions), range)
                ?? tags.latest ?? this.highestVersion(meta);
        }
        this.verCache.set(key, resolved);
        return resolved;
    }

    private async fetchMetaAsync(name: string): Promise<NpmMeta> {
        const cfg      = this.getNpmCfg();
        const registry = (name.startsWith('@') && cfg.scopeRegistries[name.split('/')[0]!])
            ? cfg.scopeRegistries[name.split('/')[0]!]!
            : cfg.registry;
        const cacheFile = joinPaths(this.cacheDir, name, 'meta.json');
        const cacheTs   = cacheFile + '.ts';
        if (fs.exists(cacheFile)) {
            try {
                const age = Date.now() - +(readText(cacheTs) || '0');
                if (age < 24 * 60 * 60 * 1000) return safeParse<NpmMeta>(readText(cacheFile));
            } catch {}
        }
        const { body } = await fetchAsync(`${registry}/${name}`, undefined, {
            method: 'GET',
            ...this.fetchOptions({ 'User-Agent': 'cts/' + version, Accept: 'application/json' }),
        });
        const meta = safeParse<NpmMeta>(engine.decodeString(new Uint8Array(body)));
        ensureDir(dirname(cacheFile));
        writeText(cacheFile, JSON.stringify(meta, null, 2));
        writeText(cacheTs, String(Date.now()));
        return meta;
    }

    private async installAsync(name: string, ver: string, dir: string, onProgress?: ProgressCallback): Promise<void> {
        const meta    = await this.fetchMetaAsync(name);
        const tarball = meta.versions[ver]?.dist.tarball;
        if (!tarball) throw err(ErrorKind.VersionNotFound, `Version ${ver} not found for ${name}`);
        const { body } = await fetchAsync(tarball, onProgress, this.fetchOptions());
        const files = unTarGz(new Uint8Array(body).buffer);
        ensureDir(dir);
        const seen = new Set<string>();
        for (const f of files) {
            let p = f.path;
            if (p.startsWith('package/')) p = p.slice(8);
            const target = joinPaths(dir, p);
            if (f.type === 'dir') { if (!seen.has(target)) { ensureDir(target); seen.add(target); } }
            else { const d = dirname(target); if (!seen.has(d)) { ensureDir(d); seen.add(d); } fs.writeFile(target, f.content); }
        }
    }
}

