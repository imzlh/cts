import type { RuntimeConfig, ModuleInfo } from '../../types';
import type { ProtocolHandler } from './base';
import type { Flow } from '../../flow';
import { errMsg } from '../../utils/misc';
import { err, ErrorKind } from '../../errors';
import { materializePayload, mimeToExt, mimeToKind, payloadCachePath } from './payload';

const engine = import.meta.use('engine');
const algorithm = import.meta.use('algorithm');
const crypto = import.meta.use('crypto');

interface DataParsed { mime: string; isBase64: boolean; data: string }

function parseDataUrl(url: string): DataParsed {
    if (!url.startsWith('data:')) throw err(ErrorKind.InvalidSpecifier, `Not a data URL: ${url}`);
    const rest = url.slice(5);
    const ci = rest.indexOf(',');
    if (ci === -1) throw err(ErrorKind.InvalidSpecifier, `Invalid data URL: ${url}`);
    const meta = rest.slice(0, ci), data = rest.slice(ci + 1);
    const isBase64 = meta.endsWith(';base64');
    // RFC 2397: an omitted media type defaults to text/plain, base64 or not.
    const mime = (isBase64 ? meta.slice(0, -7) : meta) || 'text/plain';
    return { mime, isBase64, data };
}

const IMAGE_EXT: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/svg+xml': '.svg',
};

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

/** Digest of the full data: URL. Keying by digest instead of the raw URL
 *  keeps a megabyte payload string from living in the cache key as well as
 *  the stored ModuleInfo; the digest is verified against the spec on hit. */
function dataCacheKey(spec: string): string {
    return crypto.hexEncode(crypto.md5(engine.encodeString(spec)));
}

export class DataHandler implements ProtocolHandler {
    readonly protocols = ['data'];
    private readonly resolved = new Map<string, ModuleInfo>();

    constructor(private readonly cfg: RuntimeConfig) {}

    clearCache(): void {
        this.resolved.clear();
    }

    *resolve(spec: string, _parent: string): Flow<ModuleInfo> {
        const key = dataCacheKey(spec);
        const cached = this.resolved.get(key);
        if (cached !== undefined && cached.specPath === spec) return cached;

        const parsed = parseDataUrl(spec);
        const bytes = decodeDataPayload(parsed);
        const localPath = yield* materializePayload(this.cfg.cacheDir, 'data', spec, mimeToExt(parsed.mime, IMAGE_EXT), bytes);

        const info: ModuleInfo = { specPath: spec, localPath, format: 'esm', fileKind: mimeToKind(parsed.mime) };
        this.resolved.set(key, info);
        return info;
    }

    localPath(specPath: string): string {
        const cached = this.resolved.get(dataCacheKey(specPath));
        if (cached !== undefined && cached.specPath === specPath) return cached.localPath;
        const { mime } = parseDataUrl(specPath);
        return payloadCachePath(this.cfg.cacheDir, 'data', specPath, mimeToExt(mime, IMAGE_EXT));
    }
}
