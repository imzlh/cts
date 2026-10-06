import type { FileKind } from '../../types';
import { StepType, type Flow } from '../../flow';
import { dirname, joinPaths } from '../../utils/path';
import { hashString } from '../../utils/misc';

const os = import.meta.use('os');

type PayloadProtocol = 'data' | 'blob';
type PayloadBytes = Uint8Array | ArrayBuffer;

const MIME_EXT: Record<string, string> = {
    'text/plain': '.txt', 'text/html': '.html', 'text/css': '.css',
    'text/javascript': '.js', 'application/javascript': '.js',
    'text/typescript': '.ts', 'application/typescript': '.ts',
    'text/jsx': '.jsx', 'application/jsx': '.jsx',
    'text/tsx': '.tsx', 'application/tsx': '.tsx',
    'application/json': '.json', 'application/wasm': '.wasm',
    'application/octet-stream': '.bin',
};

function mimeBase(mime: string): string {
    const semi = mime.indexOf(';');
    return semi === -1 ? mime : mime.slice(0, semi);
}

export function mimeToExt(mime: string, extra?: Record<string, string>): string {
    const base = mimeBase(mime);
    return extra?.[base] ?? MIME_EXT[base] ?? '.bin';
}

export function mimeToKind(mime: string): FileKind {
    const base = mimeBase(mime);
    if (base === 'application/wasm') return 'wasm';
    if (base === 'application/json') return 'json';
    if (base.startsWith('text/')
        || base === 'application/javascript'
        || base === 'application/typescript'
        || base === 'application/jsx'
        || base === 'application/tsx') return 'source';
    return 'binary';
}

export function payloadCachePath(cacheDir: string, protocol: PayloadProtocol, spec: string, ext: string): string {
    return joinPaths(cacheDir, protocol, hashString(spec) + ext);
}

function fallbackCacheDir(protocol: PayloadProtocol): string {
    let tmp: string;
    try { tmp = os.tmpDir; }
    catch { tmp = '/tmp'; }
    return joinPaths(tmp, `cts-${protocol}-${os.pid}`);
}

function* writePayload(path: string, bytes: PayloadBytes): Flow<string> {
    const exists = yield { type: StepType.FS_EXISTS, path };
    if (!exists) {
        yield { type: StepType.FS_ENSURE_DIR, path: dirname(path) };
        yield { type: StepType.FS_WRITE_BYTES, path, data: bytes };
    }
    return path;
}

export function* materializePayload(
    cacheDir: string,
    protocol: PayloadProtocol,
    spec: string,
    ext: string,
    bytes: PayloadBytes,
): Flow<string> {
    try {
        return yield* writePayload(payloadCachePath(cacheDir, protocol, spec, ext), bytes);
    } catch {
        return yield* writePayload(payloadCachePath(fallbackCacheDir(protocol), protocol, spec, ext), bytes);
    }
}
