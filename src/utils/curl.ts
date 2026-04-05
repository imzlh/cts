// utils/curl.ts — async HTTP via libcurl (pre-cache phase only)
//
// Concurrency limits are intentionally conservative:
//   - 8 total, 4 per host: avoids hammering jsr.io / registry.npmjs.org
//   - HTTP/2 pipelining where supported (reduces round-trips per host)
//
// This module is ONLY used by DepScanner during pre-cache.
// Normal module loading uses the sync net.ts path.

import { assert } from "./misc";
import { __use_fn, engine } from './index';

const curlMod = __use_fn('curl');
assert(curlMod, "CURL module is not included in CJS binary. Please rebuild cjs binary.");

const MAX_TOTAL_CONNS    = 8;
const MAX_PER_HOST_CONNS = 4;

let _pool: CModuleCURL.ConnPool | null = null;

function pool(): CModuleCURL.ConnPool {
    if (!_pool) {
        _pool = new curlMod!.ConnPool({
            maxConnections:        MAX_TOTAL_CONNS,
            maxConnectionsPerHost: MAX_PER_HOST_CONNS,
            pipelining:            true,
        });
    }
    return _pool;
}

export function closePool(): void {
    _pool?.close();
    _pool = null;
}

export interface FetchResult { url: string; status: number; body: Uint8Array<ArrayBuffer> }

export async function fetchAsync(
    url:         string,
    onProgress?: (done: number, total: number) => void,
): Promise<FetchResult> {
    const c = new curlMod!.CURL(pool());
    c.setUrl(url)
     .setMethod('GET')
     .setFollowRedirects(true)
     .setMaxRedirects(8)
     .setTimeout(30_000)
     .setConnectTimeout(10_000)
     .setUserAgent('cts/2.0')
     .setHTTPVersion('2TLS');

    if (onProgress) {
        c.onProgress((total, now) => { onProgress(now, total); return true; });
    }

    // Stream mode: collect chunks without buffering the whole body in libcurl
    const chunks: ArrayBuffer[] = [];
    let totalBytes = 0;
    c.setStreamMode(true);
    c.onData((buf: ArrayBuffer) => {
        chunks.push(buf);
        totalBytes += buf.byteLength;
        return false; // false = continue
    });

    const resp = await c.perform();
    if (resp.status < 200 || resp.status >= 300)
        throw new Error(`HTTP ${resp.status}: ${url}`);

    // Single allocation merge
    const body = new Uint8Array(totalBytes);
    let off = 0;
    for (const chunk of chunks) { body.set(new Uint8Array(chunk), off); off += chunk.byteLength; }

    return { url: resp.url ?? url, status: resp.status, body };
}

export async function fetchTextAsync(url: string): Promise<string> {
    const { body } = await fetchAsync(url);
    return engine.decodeString(body);
}
