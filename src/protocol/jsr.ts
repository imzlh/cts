// protocol/jsr.ts — JSR registry handler
//
// Fix vs original:
//   - Version ranges (^1.0.0) are actually resolved against the full version list
//     instead of silently falling back to `latest`.
//   - specPath always includes the resolved version (@scope/name@1.2.3/path).

import type { RuntimeConfig, ModuleInfo, ParsedJsrSpec, JsrPackageMeta, JsrVersionMeta } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { ensureDir, readText, writeText, resolveFile } from '../utils/io';
import { fetchBytes, fetchText } from '../http/fetch';
import { isCacheExpired, matchLatestVersion, safeParse, errMsg } from '../utils/misc';
import { fs, engine } from '../utils/index';
import { log } from '../utils/log';

const JSR = 'https://jsr.io';
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

export class JsrHandler implements ProtocolHandler {
    readonly protocols = ['jsr'];
    private readonly resolved = new Map<string, string>(); // specPath → localPath

    constructor(private readonly cfg: RuntimeConfig) {}

    resolve(spec: string, parent: string): ModuleInfo {
        let parsed: ParsedJsrSpec;

        // Resolve relative imports inside a JSR module first (before parseSpec)
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('jsr:')) {
            const pp = this.parseSpec(parent);
            const dir = dirname(pp.path || '/');
            parsed = {
                scope: pp.scope,
                name: pp.name,
                version: pp.version,
                path: normalizePath(joinPaths(dir, spec)),
            };
        } else {
            parsed = this.parseSpec(spec);
        }

        // Resolve version
        if (!parsed.version) parsed.version = this.latestVersion(parsed.scope, parsed.name);
        else                  parsed.version = this.resolveVersion(parsed.scope, parsed.name, parsed.version);

        const filePath  = this.resolveFilePath(parsed);
        const localPath = this.download(parsed.scope, parsed.name, parsed.version!, filePath);
        const specPath  = `jsr:@${parsed.scope}/${parsed.name}@${parsed.version}/${filePath}`;
        this.resolved.set(specPath, localPath);
        return { specPath, localPath, format: 'esm', fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string {
        if (this.resolved.has(specPath)) return this.resolved.get(specPath)!;
        const p = this.parseSpec(specPath);
        const file = (p.path.startsWith('/') ? p.path.slice(1) : p.path);
        return joinPaths(this.cfg.cacheDir, 'jsr', p.scope, p.name, p.version!, file);
    }

    // ---------------------------------------------------------------------------

    private parseSpec(spec: string): ParsedJsrSpec {
        let rest = spec.startsWith('jsr:') ? spec.slice(4) : spec;
        while (rest.startsWith('/')) rest = rest.slice(1);
        if (!rest.startsWith('@')) throw new Error(`Invalid JSR specifier: ${spec}`);
        // @scope/name[@version][/subpath]
        // Version can contain dots, dashes, plus signs (e.g., 1.0.0-beta.1)
        // Subpath can contain slashes (e.g., /src/utils/helper.ts)
        const m = rest.match(/^@([^/]+)\/([^@/]+)(?:@([^/]+))?(\/.*)?$/);
        if (!m) throw new Error(`Cannot parse JSR specifier: ${spec}`);
        const version = m[3] ?? null;
        // Validate version doesn't contain path separators if present
        if (version && version.includes('/')) {
            throw new Error(`Invalid version in JSR specifier: ${spec}`);
        }
        return { scope: m[1]!, name: m[2]!, version, path: m[4] ?? '' };
    }

    private resolveFilePath(p: ParsedJsrSpec): string {
        const meta = this.versionMeta(p.scope, p.name, p.version!);
        if (!p.path || p.path === '/' || p.path === '.') {
            const e = meta.exports?.['.'];
            if (!e) throw new Error(`No entry point in @${p.scope}/${p.name}@${p.version}`);
            return e.startsWith('./') ? e.slice(2) : e;
        }
        const norm = p.path.startsWith('/') ? p.path : '/' + p.path;
        const mapped = meta.exports?.['.' + norm];
        if (mapped) return mapped.startsWith('./') ? mapped.slice(2) : mapped;
        if (meta.manifest[norm]) return norm.slice(1);
        for (const ext of EXTS) {
            const w = norm + ext;
            if (meta.manifest[w]) return w.slice(1);
        }
        throw new Error(`File not found: ${p.path} in @${p.scope}/${p.name}@${p.version}`);
    }

    private latestVersion(scope: string, name: string): string {
        const meta = this.pkgMeta(scope, name);
        if (!meta.latest) throw new Error(`No latest version for @${scope}/${name}`);
        return meta.latest;
    }

    private resolveVersion(scope: string, name: string, ver: string): string {
        if (/^\d+\.\d+\.\d+/.test(ver)) return ver;  // already exact
        const meta = this.pkgMeta(scope, name);
        const all = Object.keys(meta.versions);
        const resolved = matchLatestVersion(all, ver);
        if (!resolved) throw new Error(`No version matching "${ver}" in @${scope}/${name}`);
        return resolved;
    }

    private pkgMeta(scope: string, name: string): JsrPackageMeta {
        const dir  = joinPaths(this.cfg.cacheDir, 'jsr', scope, name);
        const file = joinPaths(dir, 'meta.json');
        if (fs.exists(file)) {
            try {
                const c = safeParse<any>(readText(file));
                if (!isCacheExpired(c._at ?? 0, this.cfg.jsrCacheTTL)) return c;
            } catch {}
        }
        const meta = safeParse<JsrPackageMeta>(fetchText(`${JSR}/@${scope}/${name}/meta.json`));
        if (!meta.latest) throw new Error(`@${scope}/${name}: registry returned no latest`);
        ensureDir(dir);
        writeText(file, JSON.stringify({ ...meta, _at: Date.now() }, null, 2));
        return meta;
    }

    private versionMeta(scope: string, name: string, ver: string): JsrVersionMeta {
        const dir  = joinPaths(this.cfg.cacheDir, 'jsr', scope, name, ver);
        const file = joinPaths(dir, 'meta.json');
        if (fs.exists(file)) {
            try {
                const c = safeParse<any>(readText(file));
                if (!isCacheExpired(c._at ?? 0, this.cfg.jsrCacheTTL)) return c;
            } catch {}
        }
        const meta = safeParse<JsrVersionMeta>(fetchText(`${JSR}/@${scope}/${name}/${ver}_meta.json`));
        ensureDir(dir);
        writeText(file, JSON.stringify({ ...meta, _at: Date.now() }, null, 2));
        return meta;
    }

    private download(scope: string, name: string, ver: string, file: string): string {
        const local = joinPaths(this.cfg.cacheDir, 'jsr', scope, name, ver, file);
        if (!fs.exists(local)) {
            const url = `${JSR}/@${scope}/${name}/${ver}/${file}`;
            ensureDir(dirname(local));
            fs.writeFile(local, fetchBytes(url));
        }
        return local;
    }
}
