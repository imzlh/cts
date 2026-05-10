// protocol/data.ts — data: URL handler
//
// Fix vs original: urlMap tracks resolved paths so getLocalPath() is O(1)
// and the data URL is only parsed once per unique URL.

import type { RuntimeConfig, ModuleInfo, FileKind } from '../types';
import type { ProtocolHandler } from './base';
import { joinPaths, dirname } from '../utils/path';
import { ensureDir } from '../utils/io';
import { hashString, errMsg } from '../utils/misc';
import { err, ErrorKind } from '../errors';
import { fs, engine, crypto } from '../utils/index';

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
    'application/json': '.json', 'application/typescript': '.ts',
    'application/wasm': '.wasm', 'image/png': '.png', 'image/jpeg': '.jpg',
    'image/svg+xml': '.svg', 'application/octet-stream': '.bin',
};

function mimeToExt(mime: string): string {
    return MIME_EXT[mime.split(';')[0]!] ?? '.bin';
}

function mimeToKind(mime: string): FileKind {
    const m = mime.split(';')[0]!;
    if (m === 'application/wasm') return 'wasm';
    if (m === 'application/json') return 'json';
    if (m.startsWith('text/') || m === 'application/javascript' || m === 'application/typescript') return 'source';
    return 'binary';
}

export class DataHandler implements ProtocolHandler {
    readonly protocols = ['data'];
    private readonly resolved = new Map<string, string>(); // specPath → localPath

    constructor(private readonly cfg: RuntimeConfig) {}

    resolve(spec: string, _parent: string): ModuleInfo {
        if (this.resolved.has(spec)) {
            const localPath = this.resolved.get(spec)!;
            const { mime } = parseDataUrl(spec);
            return { specPath: spec, localPath, format: 'esm', fileKind: mimeToKind(mime) };
        }

        const parsed = parseDataUrl(spec);
        const localPath = joinPaths(this.cfg.cacheDir, 'data', hashString(spec) + mimeToExt(parsed.mime));

        if (!fs.exists(localPath)) {
            ensureDir(dirname(localPath));
            if (parsed.isBase64) {
                try { fs.writeFile(localPath, crypto.base64Decode(parsed.data)); }
                catch (e) { throw err(ErrorKind.Generic, `data: base64 decode failed: ${errMsg(e)}`); }
            } else {
                fs.writeFile(localPath, engine.encodeString(decodeURIComponent(parsed.data)));
            }
        }

        this.resolved.set(spec, localPath);
        return { specPath: spec, localPath, format: 'esm', fileKind: mimeToKind(parsed.mime) };
    }

    localPath(specPath: string): string {
        if (this.resolved.has(specPath)) return this.resolved.get(specPath)!;
        // Recompute deterministically (no I/O)
        const { mime } = parseDataUrl(specPath);
        return joinPaths(this.cfg.cacheDir, 'data', hashString(specPath) + mimeToExt(mime));
    }
}
