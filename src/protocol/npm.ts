// protocol/npm.ts — npm registry handler

import type { RuntimeConfig, ModuleInfo, PackageJson } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { ensureDir, readText, writeText, resolveFile } from '../utils/io';
import { fetchBytes, fetchText } from '../utils/net';
import { unTarGz, matchLatestVersion, compareVersions, safeParse, errMsg } from '../utils/misc';
import { detectFormat, readPkgFresh, createCtx, resolveSubpath } from '../pkg';
import { log } from '../utils/log';
import { fs, os, sys, console } from '../utils/index';

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
    try { const p = joinPaths(os.homedir ?? '/root', '.npmrc'); if (fs.exists(p)) parse(readText(p), false); } catch {}
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
    let name = '', ver = '', sub = '';

    if (rest.startsWith('@')) {
        const sl = rest.indexOf('/');
        if (sl === -1) throw new Error(`Invalid scoped package: ${raw}`);
        const scope = rest.slice(0, sl); rest = rest.slice(sl + 1);
        const at = rest.indexOf('@'), sl2 = rest.indexOf('/');
        if (at !== -1 && (sl2 === -1 || at < sl2)) {
            name = `${scope}/${rest.slice(0, at)}`;
            const after = rest.slice(at + 1); const sl3 = after.indexOf('/');
            ver = sl3 === -1 ? after : after.slice(0, sl3);
            sub = sl3 === -1 ? '' : after.slice(sl3 + 1);
        } else if (sl2 !== -1) {
            name = `${scope}/${rest.slice(0, sl2)}`; sub = rest.slice(sl2 + 1);
        } else { name = `${scope}/${rest}`; }
    } else {
        const at = rest.indexOf('@'), sl = rest.indexOf('/');
        if (at !== -1 && (sl === -1 || at < sl)) {
            name = rest.slice(0, at);
            const after = rest.slice(at + 1); const sl2 = after.indexOf('/');
            ver = sl2 === -1 ? after : after.slice(0, sl2);
            sub = sl2 === -1 ? '' : after.slice(sl2 + 1);
        } else if (sl !== -1) { name = rest.slice(0, sl); sub = rest.slice(sl + 1); }
        else name = rest;
    }
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
    // version cache: name@range → resolved exact version
    private readonly verCache = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {
        this.cacheDir = joinPaths(cfg.cacheDir, 'npm');
    }

    resolve(spec: string, parent: string): ModuleInfo {
        // Relative import within an npm module
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('npm:')) {
            return this.resolveRelative(spec, parent);
        }
        // require('.') means "the main entry of the current package"
        if (spec === '.' && parent.startsWith('npm:')) {
            return this.resolveRelative('.', parent);
        }
        const { name, version, subpath } = parseNpmSpec(spec);
        const pkg = this.ensureInstalled(name, version, parent);
        return this.resolvePkg(pkg.dir, pkg.resolvedVer, name, subpath);
    }

    localPath(specPath: string): string {
        const { name, version, subpath } = parseNpmSpec(specPath);
        const dir = joinPaths(this.cacheDir, `${name}@${version}`);
        const ctx = createCtx(dir);
        if (!ctx) throw new Error(`Package not installed: ${specPath}`);
        return resolveSubpath(ctx, subpath) ?? (() => { throw new Error(`Cannot resolve ${subpath} in ${name}`); })();
    }

    // ---------------------------------------------------------------------------

    private resolveRelative(spec: string, parent: string): ModuleInfo {
        const { name, version, subpath } = parseNpmSpec(parent);
        const relPath = normalizePath(joinPaths(dirname(subpath || ''), spec));
        const dir = joinPaths(this.cacheDir, `${name}@${version}`);
        return this.resolvePkg(dir, version, name, relPath);
    }

    private resolvePkg(dir: string, ver: string, name: string, subpath: string): ModuleInfo {
        const ctx = createCtx(dir, { forceCjs: false });
        if (!ctx) throw new Error(`package.json not found in ${dir}`);
        const localPath = resolveSubpath(ctx, subpath);
        if (!localPath) throw new Error(`Cannot resolve "${subpath || '.'}" in ${name}@${ver}`);
        // Build canonical specPath that includes resolved version
        const specPath = `npm:${name}@${ver}` + (subpath ? `/${subpath}` : '');
        return {
            specPath,
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
            if (!this.cfg.silent) log.info(`📦 ${name}@${exactVer}`);
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
                if (age < 60 * 60 * 1000) return safeParse<NpmMeta>(readText(cacheFile));
            } catch {}
        }
        const meta = safeParse<NpmMeta>(fetchText(`${registry}/${name}`));
        ensureDir(dirname(cacheFile));
        writeText(cacheFile, JSON.stringify(meta, null, 2));
        writeText(cacheTs, String(Date.now()));
        return meta;
    }

    private install(name: string, ver: string, dir: string): void {
        const meta    = this.fetchMeta(name);
        const tarball = meta.versions[ver]?.dist.tarball;
        if (!tarball) throw new Error(`Version ${ver} not found for ${name}`);
        const files = unTarGz(fetchBytes(tarball, true).buffer);
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

    private findLocal(name: string, parent?: string): string | null {
        const search: string[] = [];
        if (parent) {
            let d = dirname(parent.startsWith('npm:') ? joinPaths(this.cacheDir, name) : parent);
            const root = sys.platform === 'win32' ? d.split(':')[0] + ':/' : '/';
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
}
