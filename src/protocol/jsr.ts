// protocol/jsr.ts - JSR registry handler

import type { RuntimeConfig, ModuleInfo, ParsedJsrSpec, JsrPackageMeta, JsrVersionMeta } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { StepType, type Flow } from '../flow';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { safeParse, isCacheExpired, matchLatestVersion } from '../utils/misc';
import { log } from '../utils/log';
import { isatty } from '../utils/progress';
import { err, ErrorKind } from '../errors';
import { engine } from '../utils/index';

const JSR = 'https://jsr.io';
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

export class JsrHandler implements ProtocolHandler {
    readonly protocols = ['jsr'];
    private readonly resolved = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {}

    /** Clear resolved cache */
    clearCache(): void {
        this.resolved.clear();
    }

    *resolve(spec: string, parent: string): Flow<ModuleInfo> {
        let parsed: ParsedJsrSpec;
        if ((spec.startsWith('./') || spec.startsWith('../')) && parent.startsWith('jsr:')) {
            const pp = this.parseSpec(parent);
            parsed = {
                scope: pp.scope,
                name: pp.name,
                version: pp.version,
                path: normalizePath(joinPaths(dirname(pp.path || '/'), spec)),
            };
        } else {
            parsed = this.parseSpec(spec);
        }

        if (!parsed.version) parsed.version = yield* this.latestVersion(parsed.scope, parsed.name);
        else if (!/^\d+\.\d+\.\d+/.test(parsed.version)) parsed.version = yield* this.resolveVersion(parsed.scope, parsed.name, parsed.version);

        const filePath = yield* this.resolveFilePath(parsed);
        const localPath = yield* this.download(parsed.scope, parsed.name, parsed.version!, filePath);
        const specPath = `jsr:@${parsed.scope}/${parsed.name}@${parsed.version}/${filePath}`;
        this.resolved.set(specPath, localPath);
        return { specPath, localPath, format: 'esm', fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string {
        if (this.resolved.has(specPath)) return this.resolved.get(specPath)!;
        const p = this.parseSpec(specPath);
        const file = (p.path.startsWith('/') ? p.path.slice(1) : p.path);
        return joinPaths(this.cfg.cacheDir, 'jsr', p.scope, p.name, p.version!, file);
    }

    private parseSpec(spec: string): ParsedJsrSpec {
        let rest = spec.startsWith('jsr:') ? spec.slice(4) : spec;
        while (rest.startsWith('/')) rest = rest.slice(1);
        if (!rest.startsWith('@')) throw err(ErrorKind.InvalidSpecifier, `Invalid JSR specifier: ${spec}`);
        const m = rest.match(/^@([^/]+)\/([^@/]+)(?:@([^/]+))?(\/.*)?$/);
        if (!m) throw err(ErrorKind.InvalidSpecifier, `Cannot parse JSR specifier: ${spec}`);
        const version = m[3] ?? null;
        if (version && version.includes('/')) {
            throw err(ErrorKind.InvalidSpecifier, `Invalid version in JSR specifier: ${spec}`);
        }
        return { scope: m[1]!, name: m[2]!, version, path: m[4] ?? '' };
    }

    private *latestVersion(scope: string, name: string): Flow<string> {
        const meta = yield* this.pkgMeta(scope, name);
        if (!meta.latest) throw err(ErrorKind.VersionNotFound, `No latest version for @${scope}/${name}`);
        return meta.latest;
    }

    private *resolveVersion(scope: string, name: string, ver: string): Flow<string> {
        const meta = yield* this.pkgMeta(scope, name);
        const resolved = matchLatestVersion(Object.keys(meta.versions), ver);
        if (!resolved) throw err(ErrorKind.VersionNotFound, `No version matching "${ver}" in @${scope}/${name}`);
        return resolved;
    }

    private *resolveFilePath(p: ParsedJsrSpec): Flow<string> {
        const meta = yield* this.versionMeta(p.scope, p.name, p.version!);
        if (!p.path || p.path === '/' || p.path === '.') {
            const e = meta.exports?.['.'];
            if (!e) throw err(ErrorKind.ModuleNotFound, `No entry point in @${p.scope}/${p.name}@${p.version}`);
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
        throw err(ErrorKind.FileNotFound, `File not found: ${p.path} in @${p.scope}/${p.name}@${p.version}`);
    }

    private *pkgMeta(scope: string, name: string): Flow<JsrPackageMeta> {
        const dir = joinPaths(this.cfg.cacheDir, 'jsr', scope, name);
        const file = joinPaths(dir, 'meta.json');
        const exists = yield { type: StepType.FS_EXISTS, path: file };
        if (exists) {
            try {
                const c = safeParse<any>(yield { type: StepType.FS_READ_TEXT, path: file });
                if (!isCacheExpired(c._at ?? 0, this.cfg.jsrCacheTTL)) return c;
            } catch {}
        }
        const { body } = yield { type: StepType.NET_FETCH, url: `${JSR}/@${scope}/${name}/meta.json`, timeout: this.cfg.requestTimeout };
        const meta = safeParse<JsrPackageMeta>(engine.decodeString(body));
        if (!meta.latest) throw err(ErrorKind.VersionNotFound, `@${scope}/${name}: registry returned no latest`);
        yield { type: StepType.FS_ENSURE_DIR, path: dir };
        yield { type: StepType.FS_WRITE_TEXT, path: file, text: JSON.stringify({ ...meta, _at: Date.now() }, null, 2) };
        return meta;
    }

    private *versionMeta(scope: string, name: string, ver: string): Flow<JsrVersionMeta> {
        const dir = joinPaths(this.cfg.cacheDir, 'jsr', scope, name, ver);
        const file = joinPaths(dir, 'meta.json');
        const exists = yield { type: StepType.FS_EXISTS, path: file };
        if (exists) {
            try {
                const c = safeParse<any>(yield { type: StepType.FS_READ_TEXT, path: file });
                if (!isCacheExpired(c._at ?? 0, this.cfg.jsrCacheTTL)) return c;
            } catch {}
        }
        const { body } = yield { type: StepType.NET_FETCH, url: `${JSR}/@${scope}/${name}/${ver}_meta.json`, timeout: this.cfg.requestTimeout };
        const meta = safeParse<JsrVersionMeta>(engine.decodeString(body));
        yield { type: StepType.FS_ENSURE_DIR, path: dir };
        yield { type: StepType.FS_WRITE_TEXT, path: file, text: JSON.stringify({ ...meta, _at: Date.now() }, null, 2) };
        return meta;
    }

    private *download(scope: string, name: string, ver: string, file: string): Flow<string> {
        const local = joinPaths(this.cfg.cacheDir, 'jsr', scope, name, ver, file);
        const exists = yield { type: StepType.FS_EXISTS, path: local };
        if (!exists) {
            if (!this.cfg.silent && !isatty) log.download(`jsr:@${scope}/${name}@${ver}/${file}`);
            const url = `${JSR}/@${scope}/${name}/${ver}/${file}`;
            yield { type: StepType.FS_ENSURE_DIR, path: dirname(local) };
            const { body } = yield { type: StepType.NET_FETCH, url, timeout: this.cfg.requestTimeout };
            yield { type: StepType.FS_WRITE_BYTES, path: local, data: body };
        }
        return local;
    }
}
