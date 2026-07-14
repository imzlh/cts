import type { RuntimeConfig, ModuleInfo, FileKind } from '../../types';
import type { ProtocolHandler } from './base';
import { StepType, type Flow } from '../../flow';
import { joinPaths, dirname } from '../../utils/path';
import { hashString, errMsg } from '../../utils/misc';
import { err, ErrorKind } from '../../errors';

const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');
const os = import.meta.use('os');

interface DataParsed { mime: string; isBase64: boolean; data: string }

function parseDataUrl(url: string): DataParsed {
    if (!url.startsWith('data:')) throw err(ErrorKind.InvalidSpecifier, `Not a data URL: ${url}`);
    const rest = url.slice(5);
    const ci = rest.indexOf(',');
    if (ci === -1) throw err(ErrorKind.InvalidSpecifier, `Invalid data URL: ${url}`);
    const meta = rest.slice(0, ci), data = rest.slice(ci + 1);
    const isBase64 = meta.endsWith(';base64');
    const mime = isBase64 ? meta.slice(0, -7) : (meta || 'text/plain');
    return { mime, isBase64, data };
}

const MIME_EXT: Record<string, string> = {
    'text/plain': '.txt', 'text/html': '.html', 'text/css': '.css',
    'text/javascript': '.js', 'application/javascript': '.js',
    'text/typescript': '.ts', 'text/jsx': '.jsx', 'text/tsx': '.tsx',
    'application/jsx': '.jsx', 'application/tsx': '.tsx',
    'application/json': '.json', 'application/typescript': '.ts',
    'application/wasm': '.wasm', 'image/png': '.png', 'image/jpeg': '.jpg',
    'image/svg+xml': '.svg', 'application/octet-stream': '.bin',
};

function mimeBase(mime: string): string {
    const semi = mime.indexOf(';');
    return semi === -1 ? mime : mime.slice(0, semi);
}

function mimeToExt(mime: string): string {
    return MIME_EXT[mimeBase(mime)] ?? '.bin';
}

function mimeToKind(mime: string): FileKind {
    const m = mimeBase(mime);
    if (m === 'application/wasm') return 'wasm';
    if (m === 'application/json') return 'json';
    if (m.startsWith('text/')
        || m === 'application/javascript'
        || m === 'application/typescript'
        || m === 'application/jsx'
        || m === 'application/tsx') {
        return 'source';
    }
    return 'binary';
}

function dataLocalPath(cacheDir: string, spec: string, mime: string): string {
    return joinPaths(cacheDir, 'data', hashString(spec) + mimeToExt(mime));
}

function tmpDirOrDefault(): string {
    try {
        return os.tmpDir;
    } catch {
        return '/tmp';
    }
}

function fallbackCacheDir(): string {
    const tmp = tmpDirOrDefault();
    const pid = typeof os.pid === 'number' || typeof os.pid === 'string' ? String(os.pid) : 'runtime';
    return joinPaths(tmp, `cts-data-${pid}`);
}

function decodeDataPayload(parsed: DataParsed): Uint8Array | ArrayBuffer {
    if (parsed.isBase64) {
        try {
            return algorithm.base64DecodeLoose(parsed.data);
        } catch (e) {
            throw err(ErrorKind.Generic, `data: base64 decode failed: ${errMsg(e)}`);
        }
    }

    try {
        return engine.encodeString(decodeURIComponent(parsed.data));
    } catch (e) {
        throw err(ErrorKind.Generic, `data: URL decode failed: ${errMsg(e)}`);
    }
}

export class DataHandler implements ProtocolHandler {
    readonly protocols = ['data'];
    private readonly resolved = new Map<string, ModuleInfo>();

    constructor(private readonly cfg: RuntimeConfig) {}

    /** Clear resolved cache */
    clearCache(): void {
        this.resolved.clear();
    }

    private *materialize(localPath: string, bytes: Uint8Array | ArrayBuffer): Flow<void> {
        const exists = yield { type: StepType.FS_EXISTS, path: localPath };
        if (exists) return;
        yield { type: StepType.FS_ENSURE_DIR, path: dirname(localPath) };
        yield { type: StepType.FS_WRITE_BYTES, path: localPath, data: bytes };
    }

    *resolve(spec: string, _parent: string): Flow<ModuleInfo> {
        const cached = this.resolved.get(spec);
        if (cached !== undefined) return cached;

        const parsed = parseDataUrl(spec);
        const bytes = decodeDataPayload(parsed);
        let localPath = dataLocalPath(this.cfg.cacheDir, spec, parsed.mime);

        try {
            yield* this.materialize(localPath, bytes);
        } catch {
            const fallbackPath = dataLocalPath(fallbackCacheDir(), spec, parsed.mime);
            yield* this.materialize(fallbackPath, bytes);
            localPath = fallbackPath;
        }

        const info: ModuleInfo = { specPath: spec, localPath, format: 'esm', fileKind: mimeToKind(parsed.mime) };
        this.resolved.set(spec, info);
        return info;
    }

    localPath(specPath: string): string {
        const cached = this.resolved.get(specPath);
        if (cached !== undefined) return cached.localPath;
        const { mime } = parseDataUrl(specPath);
        return dataLocalPath(this.cfg.cacheDir, specPath, mime);
    }
}
