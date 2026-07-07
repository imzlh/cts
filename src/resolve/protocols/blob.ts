// protocol/blob.ts - blob: object URL handler

import type { RuntimeConfig, ModuleInfo, FileKind } from '../../types';
import type { ProtocolHandler } from './base';
import { StepType, type Flow } from '../../flow';
import { dirname, joinPaths } from '../../utils/path';
import { hashString } from '../../utils/misc';
import { err, ErrorKind } from '../../errors';

interface BlobPayload {
    type: string;
    bytes: Uint8Array | ArrayBuffer;
}

type BlobResolver = (url: string) => BlobPayload | null;

const os = import.meta.use('os');

const MIME_EXT: Record<string, string> = {
    'text/plain': '.txt',
    'text/html': '.html',
    'text/css': '.css',
    'text/javascript': '.js',
    'text/typescript': '.ts',
    'text/jsx': '.jsx',
    'text/tsx': '.tsx',
    'application/javascript': '.js',
    'application/jsx': '.jsx',
    'application/json': '.json',
    'application/typescript': '.ts',
    'application/wasm': '.wasm',
    'application/octet-stream': '.bin',
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
    if (m.startsWith('text/') || m === 'application/javascript' || m === 'application/typescript') return 'source';
    return 'binary';
}

function blobCachePath(cacheDir: string, spec: string, mime: string): string {
    return joinPaths(cacheDir, 'blob', hashString(spec) + mimeToExt(mime));
}

function tmpDirOrDefault(): string {
    try {
        return os.tmpDir;
    } catch {
        return '/tmp';
    }
}

function fallbackCacheDir(): string {
    const pid = typeof os.pid === 'number' || typeof os.pid === 'string' ? String(os.pid) : 'runtime';
    return joinPaths(tmpDirOrDefault(), `cts-blob-${pid}`);
}

function resolveBlobPayload(spec: string): BlobPayload {
    const resolver = Reflect.get(globalThis, '__cno_resolve_blob_url');
    if (typeof resolver !== 'function') {
        throw err(ErrorKind.ProtocolDisabled, 'blob: object URLs are not available in this runtime');
    }
    const payload = (resolver as BlobResolver)(spec);
    if (!payload) throw err(ErrorKind.ModuleNotFound, `Invalid object URL: ${spec}`);
    return payload;
}

export class BlobHandler implements ProtocolHandler {
    readonly protocols = ['blob'];
    private readonly resolved = new Map<string, ModuleInfo>();

    constructor(private readonly cfg: RuntimeConfig) {}

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

        const payload = resolveBlobPayload(spec);
        const mime = payload.type || 'application/javascript';
        let localPath = blobCachePath(this.cfg.cacheDir, spec, mime);

        try {
            yield* this.materialize(localPath, payload.bytes);
        } catch {
            const fallbackPath = blobCachePath(fallbackCacheDir(), spec, mime);
            yield* this.materialize(fallbackPath, payload.bytes);
            localPath = fallbackPath;
        }

        const info: ModuleInfo = {
            specPath: spec,
            localPath,
            format: 'esm',
            fileKind: mimeToKind(mime),
        };
        this.resolved.set(spec, info);
        return info;
    }

    localPath(specPath: string): string {
        const cached = this.resolved.get(specPath);
        if (cached !== undefined) return cached.localPath;
        return blobCachePath(this.cfg.cacheDir, specPath, 'application/javascript');
    }
}
