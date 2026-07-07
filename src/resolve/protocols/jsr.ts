// protocol/jsr.ts - JSR registry handler

import type { RuntimeConfig, ModuleInfo, ParsedJsrSpec, JsrPackageMeta, JsrVersionMeta } from '../../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { expectFetch, expectText, StepType, type Flow, type ProgressCallback } from '../../flow';
import { joinPaths, dirname, normalizePath } from '../../utils/path';
import { safeParse, isCacheExpired, matchLatestRecordVersion } from '../../utils/misc';
import { log } from '../../utils/log';
import { isatty } from '../../utils/progress';
import { err, ErrorKind } from '../../errors';

const engine = import.meta.use('engine');

const JSR = 'https://jsr.io';
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

type CachedJsrPackageMeta = JsrPackageMeta & { _at?: number };
type CachedJsrVersionMeta = JsrVersionMeta & { _at?: number };

function isDigitCode(c: number): boolean {
    return c >= 48 && c <= 57;
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

export class JsrHandler implements ProtocolHandler {
    readonly protocols = ['jsr'];
    private readonly resolved = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {}

    /** Clear resolved cache */
    clearCache(): void {
        this.resolved.clear();
    }

    *resolve(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Flow<ModuleInfo> {
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
        else if (!hasSemverPrefix(parsed.version)) parsed.version = yield* this.resolveVersion(parsed.scope, parsed.name, parsed.version);

        const version = parsed.version;
        if (!version) throw err(ErrorKind.VersionNotFound, `No resolved version for @${parsed.scope}/${parsed.name}`);
        const filePath = yield* this.resolveFilePath(parsed);
        const localPath = yield* this.download(parsed.scope, parsed.name, version, filePath, onProgress);
        const specPath = `jsr:@${parsed.scope}/${parsed.name}@${version}/${filePath}`;
        this.resolved.set(specPath, localPath);
        return { specPath, localPath, format: 'esm', fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string {
        const cached = this.resolved.get(specPath);
        if (cached !== undefined) return cached;
        const p = this.parseSpec(specPath);
        if (!p.version) throw err(ErrorKind.InvalidSpecifier, `JSR specifier has no version: ${specPath}`);
        const file = (p.path.startsWith('/') ? p.path.slice(1) : p.path);
        return joinPaths(this.cfg.cacheDir, 'jsr', p.scope, p.name, p.version, file);
    }

    private parseSpec(spec: string): ParsedJsrSpec {
        let rest = spec.startsWith('jsr:') ? spec.slice(4) : spec;
        while (rest.startsWith('/')) rest = rest.slice(1);
        if (!rest.startsWith('@')) throw err(ErrorKind.InvalidSpecifier, `Invalid JSR specifier: ${spec}`);
        const scopeEnd = rest.indexOf('/');
        if (scopeEnd <= 1) throw err(ErrorKind.InvalidSpecifier, `Cannot parse JSR specifier: ${spec}`);
        const scope = rest.slice(1, scopeEnd);
        let nameEnd = rest.length;
        for (let i = scopeEnd + 1; i < rest.length; i++) {
            const c = rest.charCodeAt(i);
            if (c === 64 || c === 47) {
                nameEnd = i;
                break;
            }
        }
        const name = rest.slice(scopeEnd + 1, nameEnd);
        if (!scope || !name) throw err(ErrorKind.InvalidSpecifier, `Cannot parse JSR specifier: ${spec}`);
        let version: string | null = null;
        let path = '';
        const sep = rest.charCodeAt(nameEnd);
        if (sep === 64) {
            const versionStart = nameEnd + 1;
            const pathStart = rest.indexOf('/', versionStart);
            const versionEnd = pathStart === -1 ? rest.length : pathStart;
            version = rest.slice(versionStart, versionEnd);
            if (!version) throw err(ErrorKind.InvalidSpecifier, `Cannot parse JSR specifier: ${spec}`);
            if (pathStart !== -1) path = rest.slice(pathStart);
        } else if (sep === 47) {
            path = rest.slice(nameEnd);
        }
        return { scope, name, version, path };
    }

    private *latestVersion(scope: string, name: string): Flow<string> {
        const meta = yield* this.pkgMeta(scope, name);
        if (!meta.latest) throw err(ErrorKind.VersionNotFound, `No latest version for @${scope}/${name}`);
        return meta.latest;
    }

    private *resolveVersion(scope: string, name: string, ver: string): Flow<string> {
        const meta = yield* this.pkgMeta(scope, name);
        const resolved = matchLatestRecordVersion(meta.versions, ver);
        if (!resolved) throw err(ErrorKind.VersionNotFound, `No version matching "${ver}" in @${scope}/${name}`);
        return resolved;
    }

    private *resolveFilePath(p: ParsedJsrSpec): Flow<string> {
        if (!p.version) throw err(ErrorKind.VersionNotFound, `No resolved version for @${p.scope}/${p.name}`);
        const meta = yield* this.versionMeta(p.scope, p.name, p.version);
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
                const c = safeParse<CachedJsrPackageMeta>(expectText(yield { type: StepType.FS_READ_TEXT, path: file }));
                if (!isCacheExpired(c._at ?? 0, this.cfg.jsrCacheTTL)) return c;
            } catch {}
        }
        const url = `${JSR}/@${scope}/${name}/meta.json`;
        log.debug('jsr', () => `fetch meta @${scope}/${name} <- ${url}`);
        const { body } = expectFetch(yield { type: StepType.NET_FETCH, url, timeout: this.cfg.requestTimeout });
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
                const c = safeParse<CachedJsrVersionMeta>(expectText(yield { type: StepType.FS_READ_TEXT, path: file }));
                if (!isCacheExpired(c._at ?? 0, this.cfg.jsrCacheTTL)) return c;
            } catch {}
        }
        const url = `${JSR}/@${scope}/${name}/${ver}_meta.json`;
        log.debug('jsr', () => `fetch version meta @${scope}/${name}@${ver} <- ${url}`);
        const { body } = expectFetch(yield { type: StepType.NET_FETCH, url, timeout: this.cfg.requestTimeout });
        const meta = safeParse<JsrVersionMeta>(engine.decodeString(body));
        yield { type: StepType.FS_ENSURE_DIR, path: dir };
        yield { type: StepType.FS_WRITE_TEXT, path: file, text: JSON.stringify({ ...meta, _at: Date.now() }, null, 2) };
        return meta;
    }

    private *download(scope: string, name: string, ver: string, file: string, onProgress?: ProgressCallback): Flow<string> {
        const local = joinPaths(this.cfg.cacheDir, 'jsr', scope, name, ver, file);
        const exists = yield { type: StepType.FS_EXISTS, path: local };
        if (!exists) {
            if (!this.cfg.silent && !isatty) log.download(`jsr:@${scope}/${name}@${ver}/${file}`);
            const url = `${JSR}/@${scope}/${name}/${ver}/${file}`;
            log.debug('jsr', () => `fetch file @${scope}/${name}@${ver}/${file} <- ${url}`);
            yield { type: StepType.FS_ENSURE_DIR, path: dirname(local) };
            const { body } = expectFetch(yield { type: StepType.NET_FETCH, url, timeout: this.cfg.requestTimeout, onProgress });
            yield { type: StepType.FS_WRITE_BYTES, path: local, data: body };
        }
        return local;
    }
}
