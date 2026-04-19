// http/async_client.ts — async HTTP client using async TCP + SSL
//
// Replaces the libcurl-based curl.ts for the pre-cache phase.
// Uses the same connection pool, request builder, and response parser
// as the sync path, but with async TCP read/write for concurrency.

import { URL } from './url';
import { HttpRequestBuilder, HttpResponseParser, type HttpVersion } from './http';
import { type ConnectionConfig } from './connection';
import { engine, streams, ssl, dns, os, fs } from '../utils';
import { version } from '../../package.json';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

const MAX_REDIRECTS = 8;

// ---------------------------------------------------------------------------
// Async TCP connection — thin wrapper over streams.TCP + ssl.Pipe
// ---------------------------------------------------------------------------

interface AsyncConn {
    socket: CModuleStreams.TCP;
    sslPipe: CModuleSSL.Pipe | null;
    close(): void;
    write(data: Uint8Array): Promise<void>;
    read(buf: Uint8Array): Promise<number | null>;
}

async function connectAsync(cfg: ConnectionConfig): Promise<AsyncConn> {
    const socket = new streams.TCP();
    let sslPipe: CModuleSSL.Pipe | null = null;

    // Async DNS resolve
    const addrs = await dns.resolve(cfg.hostname, { family: os.AF_UNSPEC });
    if (!addrs || !addrs.length) {
        throw new Error(`DNS resolution failed for ${cfg.hostname}`);
    }
    const addr = addrs.find(a => a.family === 4) || addrs[0];
    if (!addr) throw new Error(`No IP address found for ${cfg.hostname}`);

    // Async TCP connect
    await socket.connect({ ip: addr.ip, port: cfg.port });

    // TLS handshake for HTTPS
    if (cfg.protocol === 'https:') {
        sslPipe = await performTLSHandshake(socket, cfg.hostname);
    }

    return {
        socket,
        sslPipe,
        close() {
            try { if (sslPipe) sslPipe.shutdown(); } catch {}
            try { socket.close(); } catch {}
        },
        async write(data: Uint8Array): Promise<void> {
            if (sslPipe) {
                const written = sslPipe.write(data);
                if (written < 0) throw new Error(`SSL_write failed: ${written}`);
                const encrypted = sslPipe.getOutput();
                if (encrypted) {
                    await socket.write(new Uint8Array(encrypted));
                }
            } else {
                await socket.write(data);
            }
        },
        async read(buf: Uint8Array): Promise<number | null> {
            if (sslPipe) {
                // Try to read plaintext first
                const plain = sslPipe.read(buf.length);
                if (plain && plain.byteLength > 0) {
                    buf.set(new Uint8Array(plain), 0);
                    return plain.byteLength;
                }
                // Read ciphertext from socket
                const n = await socket.read(buf);
                if (n === null) return null;
                if (n === 0) return 0;
                // Feed ciphertext to SSL
                const ciphertext = buf.subarray(0, n);
                const consumed = sslPipe.feed(ciphertext);
                if (consumed < 0) throw new Error(`SSL feed error: ${consumed}`);
                // Read resulting plaintext
                const result = sslPipe.read(buf.length);
                if (result && result.byteLength > 0) {
                    const arr = new Uint8Array(result);
                    buf.set(arr, 0);
                    return arr.length;
                }
                return 0;
            } else {
                return socket.read(buf);
            }
        },
    };
}

async function performTLSHandshake(socket: CModuleStreams.TCP, hostname: string): Promise<CModuleSSL.Pipe> {
    // Find system CA
    let caPath: string | undefined;
    const sysname = os.uname().sysname;
    const candidates = sysname === 'Linux' ? [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
        "/etc/pki/tls/cert.pem",
        "/etc/ssl/cert.pem",
    ] : sysname === 'Darwin' ? [
        "/etc/ssl/cert.pem",
        "/usr/local/etc/openssl/cert.pem",
        "/opt/homebrew/etc/openssl/cert.pem",
    ] : [];
    for (const p of candidates) {
        try { if (fs.stat(p).isFile) { caPath = p; break; } } catch {}
    }

    const ctx = new ssl.Context({ mode: 'client', verify: !!caPath, ca: caPath });
    const pipe = new ssl.Pipe(ctx, { servername: hostname });
    pipe.handshake();

    // Send initial ClientHello
    const initialData = pipe.getOutput();
    if (initialData) await socket.write(new Uint8Array(initialData));

    // Drive handshake loop
    const buf = new Uint8Array(16384);
    while (!pipe.handshakeComplete) {
        const n = await socket.read(buf);
        if (n === null) throw new Error('TLS handshake failed: connection closed');
        if (n === 0) continue;

        let toFeed = buf.subarray(0, n);
        while (toFeed.length > 0) {
            const consumed = pipe.feed(toFeed);
            if (consumed <= 0) throw new Error(`SSL feed failed during handshake: consumed=${consumed}`);
            toFeed = toFeed.subarray(consumed);
        }

        pipe.handshake();
        const responseData = pipe.getOutput();
        if (responseData) await socket.write(new Uint8Array(responseData));
    }

    return pipe;
}

// ---------------------------------------------------------------------------
// fetchAsync — async HTTP GET with redirect following
// ---------------------------------------------------------------------------

export interface FetchResult { url: string; status: number; body: Uint8Array }

export async function fetchAsync(
    url:         string,
    onProgress?: (done: number, total: number) => void,
    httpVersion: HttpVersion = '1.1',
): Promise<FetchResult> {
    let cur = url;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        const u    = new URL(cur);
        const port = u.port ? +u.port : (u.protocol === 'https:' ? 443 : 80);
        const cfg: ConnectionConfig = { hostname: u.hostname, port, protocol: u.protocol as any };

        const conn = await connectAsync(cfg);
        try {
            // Build and send request
            const reqData = new HttpRequestBuilder(u, {
                method: 'GET',
                version: httpVersion,
                headers: { 'User-Agent': 'cts/' + version, Accept: '*/*' },
            }).build();
            await conn.write(reqData);

            // Parse response
            const parser = new HttpResponseParser();
            let status = 0, location = '';
            let contentLength = 0;
            let isHttp10 = false;

            let buf: Uint8Array | null = null;
            let bufPos = 0;
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
            };

            parser.onData = (chunk: Uint8Array) => {
                if (buf) {
                    const remaining = buf.length - bufPos;
                    if (chunk.length <= remaining) {
                        buf.set(chunk, bufPos);
                        bufPos += chunk.length;
                    } else {
                        const old = buf.slice(0, bufPos);
                        chunks = [old, chunk];
                        chunksTotal = old.length + chunk.length;
                        buf = null;
                    }
                } else {
                    chunks!.push(chunk);
                    chunksTotal += chunk.length;
                }
                onProgress?.(bufPos || chunksTotal, contentLength || 0);
            };

            // Read response
            const readBuf = new Uint8Array(128 * 1024);
            while (!parser.isCompleted) {
                const n = await conn.read(readBuf);
                if (n === null) {
                    // EOF — for HTTP/1.0 without Content-Length, this is end of body
                    if (isHttp10 && !contentLength && parser.isHeadersComplete) break;
                    break;
                }
                if (n === 0) continue;
                parser.feed(readBuf.subarray(0, n));
            }

            if (!parser.isCompleted && !(isHttp10 && !contentLength)) {
                throw new Error('Incomplete HTTP response');
            }

            // Handle redirect
            if (status >= 300 && status < 400 && location) {
                conn.close();
                cur = location.startsWith('/') ? new URL(location, cur).toString() : location;
                continue;
            }

            conn.close();

            if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${cur}`);

            // Return body
            const _buf = buf as any as Uint8Array;
            if (buf) return { url: cur, status, body: bufPos === _buf.length ? _buf : _buf.slice(0, bufPos) };
            if (!chunks || chunksTotal === 0) return { url: cur, status, body: new Uint8Array(0) };
            const merged = new Uint8Array(chunksTotal);
            let off = 0;
            for (const c of (chunks as Uint8Array[])) { merged.set(c, off); off += c.length; }
            return { url: cur, status, body: merged };
        } catch (e) {
            conn.close();
            throw e;
        }
    }
    throw new Error(`Too many redirects: ${url}`);
}

export async function fetchTextAsync(url: string, httpVersion?: HttpVersion): Promise<string> {
    const { body } = await fetchAsync(url, undefined, httpVersion);
    return engine.decodeString(body);
}
