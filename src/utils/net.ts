// utils/net.ts — synchronous HTTP fetch with pre-allocated body buffer

import { URL } from '../http/url';
import { type ConnectionConfig, connectionManager } from '../http/connection';
import { HttpRequestBuilder, HttpResponseParser, type HttpVersion } from '../http/http';
import { HttpProgressBar } from '../http/process';
import { engine } from './index';
import { version } from '../../package.json';

const PROGRESS_MIN  = 32 * 1024;
const MAX_REDIRECTS = 8;

export function fetchBytes(url: string, showProgress = false, httpVersion: HttpVersion = '1.1'): Uint8Array<ArrayBuffer> {
    let cur = url;
    for (let n = 0; n <= MAX_REDIRECTS; n++) {
        const u    = new URL(cur);
        const port = u.port ? +u.port : (u.protocol === 'https:' ? 443 : 80);
        const cfg: ConnectionConfig = { hostname: u.hostname, port, protocol: u.protocol as any };
        const conn = connectionManager.acquire(cfg);
        let   bar: HttpProgressBar | null = null;

        try {
            conn.write(new HttpRequestBuilder(u, {
                method: 'GET',
                version: httpVersion,
                headers: { 'User-Agent': 'cts/' + version, Accept: '*/*' },
            }).build());

            const parser = new HttpResponseParser();
            let status   = 0, location = '';
            let contentLength = 0;
            let isHttp10 = false;

            // Pre-allocated buffer — avoids O(n²) copies when Content-Length is known
            let buf: Uint8Array | null = null;
            let bufPos = 0;
            // Fallback chunk list when Content-Length is unknown
            let chunks: Uint8Array[] | null = null;
            let chunksTotal = 0;

            parser.onHeadersComplete = (code: number, hdrs: any) => {
                status = code;
                location = hdrs?.get?.('location') ?? '';
                contentLength = +(hdrs?.get?.('content-length') ?? 0);
                isHttp10 = parser.isHttp10;
                if (contentLength > 0) {
                    buf = new Uint8Array(contentLength);
                } else {
                    chunks = [];
                }
                if (showProgress && contentLength > PROGRESS_MIN) {
                    bar = new HttpProgressBar({ total: contentLength, width: 40, showSpeed: true, showTime: true, updateInterval: 500 });
                    bar.start(cur);
                }
            };

            parser.onData = (chunk: Uint8Array) => {
                if (buf) {
                    // Pre-allocated path: write directly, handle overflow gracefully
                    const remaining = buf.length - bufPos;
                    if (chunk.length <= remaining) {
                        buf.set(chunk, bufPos);
                        bufPos += chunk.length;
                    } else {
                        // Content-Length was wrong — fall back to chunk list
                        const old = buf.slice(0, bufPos);
                        chunks = [old, chunk];
                        chunksTotal = old.length + chunk.length;
                        buf = null;
                    }
                } else {
                    chunks!.push(chunk);
                    chunksTotal += chunk.length;
                }
                bar?.update(bufPos || chunksTotal);
            };
            parser.onError = (e: Error) => { throw e; };

            // HTTP/1.0 without Content-Length and without chunked transfer:
            // the response body is terminated by connection close (EOF).
            // In this case, we read until EOF (conn.read returns null).
            while (!parser.isCompleted) {
                const d = conn.read(128 * 1024, true);
                if (!d) {
                    // EOF — connection closed by server.
                    // For HTTP/1.0 without Content-Length, this signals end of body.
                    // Mark the parser as completed so we can return what we have.
                    if (isHttp10 && !contentLength && parser.isHeadersComplete && !parser.isCompleted) {
                        // Force completion for HTTP/1.0 EOF-terminated responses
                        break;
                    }
                    break;
                }
                parser.feed(d);
            }
            if (!parser.isCompleted && !(isHttp10 && !contentLength)) {
                throw new Error('Incomplete HTTP response');
            }
            let _bar: HttpProgressBar | null = bar as any;  // type cast
            let _buf: Uint8Array<ArrayBuffer> | null = buf as any;
            _bar?.complete(); bar = null;

            if (status >= 300 && status < 400 && location) {
                // HTTP/1.0 servers may send Connection: close with redirects
                // Always close the connection for HTTP/1.0 redirects
                if (isHttp10) {
                    conn.close();
                } else {
                    connectionManager.release(cfg, conn);
                }
                cur = location.startsWith('/') ? new URL(location, cur).toString() : location;
                continue;
            }
            // HTTP/1.0 connections are not keep-alive by default
            if (isHttp10) {
                conn.close();
            } else {
                connectionManager.release(cfg, conn);
            }
            if (status < 200 || status >= 300) throw new Error(`HTTP ${status} ${cur}`);

            // Return the body
            if (_buf) return bufPos === _buf.length ? _buf : _buf.slice(0, bufPos);
            if (!chunks || chunksTotal === 0) return new Uint8Array(0);
            // Merge chunks in one allocation
            const merged = new Uint8Array(chunksTotal);
            let off = 0;
            for (const c of (chunks as Uint8Array[])) {
                merged.set(c, off); off += c.length;
            }
            return merged;
        } catch (e) {
            conn.close(); (bar as null | HttpProgressBar)?.complete();
            throw e;
        }
    }
    throw new Error(`Too many redirects: ${url}`);
}

export const fetchText = (url: string, httpVersion?: HttpVersion) => engine.decodeString(fetchBytes(url, false, httpVersion));
