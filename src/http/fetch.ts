import { Headers } from "headers-polyfill";
import { connectionManager, type ConnectionConfig } from "./connection";
import { HttpRequestBuilder, HttpResponseParser, type ReqInit, type HttpVersion } from "./http";
import { URL } from "./url";
import { err, ErrorKind } from '../errors';
import { engine } from "../utils/index";
import { version } from "../../package.json";

const MAX_REDIRECTS = 8;

export type ProgressCallback = (now: number, total: number) => void;

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
    }
    return merged;
}

function doFetch(
    _url: string | URL,
    onProgress: ProgressCallback | undefined,
    options: ReqInit | undefined,
    maxRedirects: number,
): { status: number; headers: Headers; body: Uint8Array } {
    const builder = new HttpRequestBuilder(_url, options);
    const parser = new HttpResponseParser();
    const req = builder.build();
    const url = new URL(_url);

    const config: ConnectionConfig = {
        hostname: url.hostname,
        port: url.port ? +url.port : (url.protocol === 'https:' ? 443 : 80),
        protocol: url.protocol as any,
    };
    const conn = connectionManager.acquire(config);

    try {
        conn.write(req);

        let status = 0, location = '', contentLength = 0, isHttp10 = false;
        let buf: Uint8Array | null = null;
        let bufPos = 0;
        let chunks: Uint8Array[] = [];
        let chunksTotal = 0;
        let useBuf = false;
        let parseError: Error | null = null;

        parser.onHeadersComplete = (code: number, hdrs: any) => {
            status = code;
            location = hdrs?.get?.('location') ?? '';
            contentLength = +(hdrs?.get?.('content-length') ?? 0);
            isHttp10 = parser.isHttp10;
            if (contentLength > 0) {
                buf = new Uint8Array(contentLength);
                useBuf = true;
            }
        };

        parser.onData = (chunk: Uint8Array) => {
            if (useBuf && buf) {
                const remaining = buf.length - bufPos;
                if (chunk.length <= remaining) {
                    buf.set(chunk, bufPos);
                    bufPos += chunk.length;
                } else {
                    chunks = [buf.slice(0, bufPos), chunk];
                    chunksTotal = bufPos + chunk.length;
                    useBuf = false;
                }
            } else {
                chunks.push(chunk);
                chunksTotal += chunk.length;
            }
            onProgress?.(useBuf ? bufPos : chunksTotal, contentLength);
        };

        // Capture parse errors via flag instead of throwing inside a callback
        // (throw in a callback is not caught by the surrounding while loop)
        parser.onError = (e: Error) => { parseError = e; };

        while (!parser.isCompleted && !parseError) {
            const d = conn.read(128 * 1024, true);
            if (!d) {
                // Connection closed by server — end of response for:
                //   HTTP/1.0: always (connection close = end of response)
                //   HTTP/1.1: when no Content-Length and no Transfer-Encoding: chunked
                //              (server signals end by closing the connection)
                break;
            }
            parser.feed(d);
        }

        if (parseError) throw parseError;
        if (!parser.isCompleted) {
            // If the parser didn't see a complete message, the response is only
            // valid when the connection was closed by the server (no data remaining).
            // This happens with HTTP/1.0 or HTTP/1.1 without Content-Length/chunked.
            // Re-raise as a network error with a clear message.
            if (!parser.isHeadersComplete) {
                throw err(ErrorKind.NetworkError, `Incomplete HTTP response from ${url}: no headers received`);
            }
            // Headers received but message not marked complete — server likely
            // closed the connection to signal end-of-body. Accept the data we got.
        }

        const headers = parser.getHeaders();

        if (status >= 300 && status < 400 && location) {
            if (maxRedirects <= 0) throw err(ErrorKind.NetworkError, `Too many redirects (>${MAX_REDIRECTS}) following ${url}`);
            if (isHttp10) conn.close();
            else connectionManager.release(config, conn);
            const nextUrl = location.startsWith('/') ? new URL(location, url).toString() : location;
            return doFetch(nextUrl, onProgress, options, maxRedirects - 1);
        }

        if (isHttp10) conn.close();
        else connectionManager.release(config, conn);

        if (status < 200 || status >= 300) throw err(ErrorKind.NetworkError, `HTTP ${status} ${url}`);

        const body = useBuf && buf
            ? (bufPos === buf.length ? buf : buf.slice(0, bufPos))
            : mergeChunks(chunks);

        return { status, headers, body };
    } catch (e) {
        conn.close();
        throw e;
    }
}

export function fetch(
    _url: string | URL,
    onProgress?: ProgressCallback,
    options?: ReqInit & { maxRedirects?: number }
): { status: number; headers: Headers; body: Uint8Array } {
    const maxRedirects = options?.maxRedirects ?? MAX_REDIRECTS;
    return doFetch(_url, onProgress, options, maxRedirects);
}

export function fetchBytes(
    url: string,
    onProgress?: ProgressCallback,
    httpVersion: HttpVersion = '1.1'
): Uint8Array<ArrayBuffer> {
    return fetch(url, onProgress, {
        method: 'GET',
        version: httpVersion,
        headers: { 'User-Agent': 'cts/' + version, Accept: '*/*' },
    }).body as Uint8Array<ArrayBuffer>;
}

export const fetchText = (url: string, httpVersion?: HttpVersion) =>
    engine.decodeString(fetchBytes(url, undefined, httpVersion));

async function doFetchAsync(
    _url: string | URL,
    onProgress: ProgressCallback | undefined,
    options: ReqInit | undefined,
    maxRedirects: number,
): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const builder = new HttpRequestBuilder(_url, options);
    const parser = new HttpResponseParser();
    const req = builder.build();
    const url = new URL(_url);

    const config: ConnectionConfig = {
        hostname: url.hostname,
        port: url.port ? +url.port : (url.protocol === 'https:' ? 443 : 80),
        protocol: url.protocol as any,
    };
    const conn = await connectionManager.acquireAsync(config);

    try {
        await conn.writeAsync(req);

        let status = 0, contentLength = 0;
        let isHttp10 = false;
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        let parseError: Error | null = null;

        parser.onHeadersComplete = (code: number, hdrs: any) => {
            status = code;
            contentLength = +(hdrs?.get?.('content-length') ?? 0);
            isHttp10 = parser.isHttp10;
        };

        parser.onData = (chunk: Uint8Array) => {
            chunks.push(chunk);
            loaded += chunk.length;
            onProgress?.(loaded, contentLength);
        };

        // Capture parse errors via flag instead of throwing inside a callback
        parser.onError = (e: Error) => { parseError = e; };

        while (!parser.isCompleted && !parseError) {
            const d = await conn.readAsync(128 * 1024, true);
            if (!d) {
                // Connection closed by server — end of response for:
                //   HTTP/1.0: always (connection close = end of response)
                //   HTTP/1.1: when no Content-Length and no Transfer-Encoding: chunked
                break;
            }
            parser.feed(d);
        }

        if (parseError) throw parseError;
        if (!parser.isCompleted) {
            if (!parser.isHeadersComplete) {
                throw err(ErrorKind.NetworkError, `Incomplete HTTP response from ${url}: no headers received`);
            }
            // Headers received but message not marked complete — server likely
            // closed the connection to signal end-of-body. Accept the data we got.
        }

        const headers = parser.getHeaders();
        const location = headers.get('location') ?? '';

        if (status >= 300 && status < 400 && location) {
            if (maxRedirects <= 0) throw err(ErrorKind.NetworkError, `Too many redirects (>${MAX_REDIRECTS}) following ${url}`);
            if (isHttp10) conn.close();
            else connectionManager.release(config, conn);
            const nextUrl = location.startsWith('/') ? new URL(location, url).toString() : location;
            return doFetchAsync(nextUrl, onProgress, options, maxRedirects - 1);
        }

        if (isHttp10) conn.close();
        else connectionManager.release(config, conn);

        if (status < 200 || status >= 300) throw err(ErrorKind.NetworkError, `HTTP ${status} ${url}`);

        return { status, headers, body: mergeChunks(chunks) };
    } catch (e) {
        conn.close();
        throw e;
    }
}

export async function fetchAsync(
    _url: string | URL,
    onProgress?: ProgressCallback,
    options?: ReqInit & { maxRedirects?: number }
): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const maxRedirects = options?.maxRedirects ?? MAX_REDIRECTS;
    return doFetchAsync(_url, onProgress, options, maxRedirects);
}
