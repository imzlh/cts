import type { RuntimeConfig, ModuleInfo } from '../../types';
import type { ProtocolHandler } from './base';
import type { Flow } from '../../flow';
import { err, ErrorKind } from '../../errors';
import { materializePayload, mimeToExt, mimeToKind, payloadCachePath } from './payload';

interface BlobPayload {
    type: string;
    bytes: Uint8Array | ArrayBuffer;
}

type BlobResolver = (url: string) => BlobPayload | null;

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

    *resolve(spec: string, _parent: string): Flow<ModuleInfo> {
        const cached = this.resolved.get(spec);
        if (cached !== undefined) return cached;

        const payload = resolveBlobPayload(spec);
        const mime = payload.type || 'application/javascript';
        const localPath = yield* materializePayload(this.cfg.cacheDir, 'blob', spec, mimeToExt(mime), payload.bytes);

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
        return payloadCachePath(this.cfg.cacheDir, 'blob', specPath, '.js');
    }
}
