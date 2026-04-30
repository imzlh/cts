/**
 * HTTP/HTTPS Connection Manager
 * Implements Keep-Alive pooling with connection reuse and automatic cleanup.
 *
 * Critical OpenSSL BIO behavior:
 * - feed() returns bytes consumed (may be < input length)
 * - read() returns 0 when no data buffered (NOT an error)
 * - handshake() must be called repeatedly until complete
 *
 * Socket read semantics:
 * - null = EOF (connection closed)
 * - 0 = EAGAIN (try again, no data available now)
 * - n > 0 = bytes read
 */
import { streams, ssl, dns, os, timers, fs } from '../utils';
import { log } from '../utils/log';

function assert(condition: any, message?: string): asserts condition {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

let _caPath: string | null | undefined = undefined;

function findSystemCaPath(): string | null {
    if (_caPath !== undefined) return _caPath;
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
    ] : [
        "C:\\Windows\\cacert.pem",
        "C:\\Program Files\\OpenSSL-Win64\\bin\\curl-ca-bundle.crt",
        "C:\\Program Files\\Git\\mingw64\\ssl\\cert.pem",
    ];
    for (const p of candidates) {
        try { if (fs.stat(p).isFile) { _caPath = p; return p; } } catch {}
    }
    _caPath = null;
    return null;
}

export interface ConnectionConfig {
    hostname: string;
    port: number;
    protocol: "http:" | "https:";
    timeout?: number;
    keepAlive?: boolean;
    keepAliveTimeout?: number;
    maxSockets?: number;
}

export enum ConnectionState {
    IDLE       = "idle",
    ACTIVE     = "active",
    CONNECTING = "connecting",
    CLOSED     = "closed"
}

export interface ConnectionLike {
    socket:   CModuleStreams.TCP;
    sslPipe:  CModuleSSL.Pipe | null;
    state:    ConnectionState;
    lastUsed: number;
    requests: number;
    connect(): void;
    write(data: Uint8Array): void;
    read(size?: number, waitForData?: boolean): Uint8Array | null;
    markActive(): void;
    markIdle(): void;
    close(): void;
    isAvailable(): boolean;
    isClosed(): boolean;
}

export class Connection implements ConnectionLike {
    public socket:   CModuleStreams.TCP;
    public sslPipe:  CModuleSSL.Pipe | null = null;
    public state:    ConnectionState        = ConnectionState.CONNECTING;
    public lastUsed: number                 = Date.now();
    public requests: number                 = 0;

    private idleTimer: number | null = null;
    private config: ConnectionConfig;
    private pendingCiphertext: Uint8Array | null = null;

    constructor(cfg: ConnectionConfig) {
        this.config = cfg;
        this.socket = new streams.TCP();
    }

    connect(): void {
        try {
            const addrs = dns.resolveSync(this.config.hostname, { family: os.AF_UNSPEC });
            if (!addrs || !addrs.length) {
                throw new Error(`DNS resolution failed for ${this.config.hostname}`);
            }
            const addr = addrs.find(a => a.family === 4) || addrs[0];
            assert(addr, `No IP address found for ${this.config.hostname}`);

            this.socket.connectSync({ ip: addr.ip, port: this.config.port });
            this.socket.setBlocking(true);

            if (this.config.protocol === "https:") {
                this.performTLSHandshake();
            }

            this.state = ConnectionState.IDLE;
            this.startIdleTimer();
        } catch (err) {
            this.state = ConnectionState.CLOSED;
            try { this.socket.close(); } catch {}
            throw err;
        }
    }

    write(data: Uint8Array) {
        if (this.sslPipe) {
            const written = this.sslPipe.write(data);
            if (written < 0) {
                throw new Error(`SSL_write failed: ${written}`);
            }
            const encrypted = this.sslPipe.getOutput();
            if (encrypted) {
                this.socket.writeSync(new Uint8Array(encrypted));
            }
        } else {
            this.socket.writeSync(data);
        }
    }

    read(size = 16384, waitForData = false): Uint8Array | null {
        return this.sslPipe
            ? this.readSSL(size, waitForData)
            : this.readPlain(size, waitForData);
    }

    private readSSL(size: number, waitForData: boolean): Uint8Array | null {
        const maxAttempts = waitForData ? 10 : 1;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (this.pendingCiphertext && this.pendingCiphertext.length > 0) {
                const consumed = this.feedCiphertext(this.pendingCiphertext);
                if (consumed > 0) {
                    this.pendingCiphertext = consumed < this.pendingCiphertext.length
                        ? this.pendingCiphertext.subarray(consumed)
                        : null;
                }
            }

            const plaintext = this.sslPipe!.read(size);
            if (plaintext && plaintext.byteLength > 0) {
                return new Uint8Array(plaintext);
            }

            const cipherBuf = new Uint8Array(size);
            const n = this.socket.readSync(cipherBuf);

            if (n === null) return null;

            if (n === 0) {
                if (!waitForData) {
                    const finalPlaintext = this.sslPipe!.read(size);
                    if (finalPlaintext && finalPlaintext.byteLength > 0) {
                        return new Uint8Array(finalPlaintext);
                    }
                    return null;
                }
                if (attempt < maxAttempts - 1) {
                    this.sleep(10);
                }
                continue;
            }

            const ciphertext = cipherBuf.subarray(0, n);
            const consumed = this.feedCiphertext(ciphertext);

            if (consumed < ciphertext.length) {
                const unfed = ciphertext.subarray(consumed);
                this.pendingCiphertext = this.pendingCiphertext
                    ? (() => { const m = new Uint8Array(this.pendingCiphertext!.length + unfed.length); m.set(this.pendingCiphertext!); m.set(unfed, this.pendingCiphertext!.length); return m; })()
                    : unfed;
            }

            const newPlaintext = this.sslPipe!.read(size);
            if (newPlaintext && newPlaintext.byteLength > 0) {
                return new Uint8Array(newPlaintext);
            }

            if (!waitForData) return null;
        }
        return null;
    }

    private readPlain(size: number, waitForData: boolean): Uint8Array | null {
        const buf = new Uint8Array(size);
        const n = this.socket.readSync(buf);

        if (n === null) return null;
        if (n === 0) {
            if (!waitForData) return null;
            for (let i = 0; i < 3; i++) {
                this.sleep(10);
                const retryN = this.socket.readSync(buf);
                if (retryN === null) return null;
                if (retryN > 0) return buf.subarray(0, retryN);
            }
            return null;
        }
        return buf.subarray(0, n);
    }

    markActive(): void {
        this.stopIdleTimer();
        this.state    = ConnectionState.ACTIVE;
        this.lastUsed = Date.now();
        this.requests++;
    }

    markIdle(): void {
        this.state    = ConnectionState.IDLE;
        this.lastUsed = Date.now();
        if (this.config.keepAlive) {
            this.startIdleTimer();
        } else {
            this.close();
        }
    }

    close(): void {
        if (this.state === ConnectionState.CLOSED) return;
        this.stopIdleTimer();
        try {
            if (this.sslPipe) this.sslPipe.shutdown();
            this.socket.close();
        } catch {}
        this.state = ConnectionState.CLOSED;
        this.pendingCiphertext = null;
    }

    isAvailable(): boolean { return this.state === ConnectionState.IDLE; }
    isClosed(): boolean    { return this.state === ConnectionState.CLOSED; }

    private performTLSHandshake(): void {
        const caPath = findSystemCaPath();
        const ctx = new ssl.Context({
            mode  : "client",
            verify: !!caPath,
            ca    : caPath ?? undefined
        });

        if (!caPath) {
            log.warn('connection', 'No system CA bundle found - disabling certificate verification');
        }

        this.sslPipe = new ssl.Pipe(ctx, { servername: this.config.hostname });
        this.sslPipe.handshake();

        const initialData = this.sslPipe.getOutput();
        if (initialData) {
            this.socket.writeSync(new Uint8Array(initialData));
        }

        while (!this.sslPipe.handshakeComplete) {
            const buf = new Uint8Array(16384);
            const n = this.socket.readSync(buf);

            if (n === null) throw new Error("TLS handshake failed: connection closed (EOF)");
            if (n === 0)    throw new Error("TLS handshake failed: no data available (EAGAIN)");

            let toFeed = buf.subarray(0, n);
            while (toFeed.length > 0) {
                const consumed = this.feedCiphertext(toFeed);
                if (consumed === 0) break;
                if (consumed < 0) throw new Error(`SSL feed failed during handshake: consumed=${consumed}`);
                toFeed = toFeed.subarray(consumed);
            }

            this.sslPipe.handshake();

            const responseData = this.sslPipe.getOutput();
            if (responseData) {
                this.socket.writeSync(new Uint8Array(responseData));
            }
        }
    }

    private feedCiphertext(data: Uint8Array): number {
        if (!this.sslPipe) return 0;
        const consumed = this.sslPipe.feed(data);
        if (consumed < 0) throw new Error(`SSL feed error: ${consumed}`);
        return consumed;
    }

    private sleep(ms: number): void {
        const start = Date.now();
        while (Date.now() - start < ms) {}
    }

    private startIdleTimer(): void {
        if (!this.config.keepAlive) return;
        this.stopIdleTimer();
        const timeout = this.config.keepAliveTimeout || 5000;
        this.idleTimer = timers.setTimeout(() => {
            if (this.state === ConnectionState.IDLE) this.close();
        }, timeout);
    }

    private stopIdleTimer(): void {
        if (this.idleTimer !== null) {
            timers.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}

export class ConnectionManager {
    private pools = new Map<string, Connection[]>();

    private defaultConfig: Partial<ConnectionConfig> = {
        timeout         : 30000,
        keepAlive       : true,
        keepAliveTimeout: 5000,
        maxSockets      : 10
    };

    private getKey(cfg: ConnectionConfig): string {
        return `${cfg.protocol}//${cfg.hostname}:${cfg.port}`;
    }

    private closeIdleConnections(key: string): void {
        const pool = this.pools.get(key) || [];
        for (const conn of pool) {
            if (conn.state === ConnectionState.IDLE) conn.close();
        }
    }

    acquire(cfg: ConnectionConfig): Connection {
        const fullCfg = { ...this.defaultConfig, ...cfg } as ConnectionConfig;
        const key = this.getKey(fullCfg);

        this.cleanupPool(key);

        const pool = this.pools.get(key) || [];
        const available = pool.find(c => c.isAvailable());

        if (available) {
            available.markActive();
            return available;
        }

        const maxSockets = fullCfg.maxSockets || 10;
        if (pool.length >= maxSockets) {
            this.closeIdleConnections(key);
        }

        const conn = new Connection(fullCfg);
        conn.connect();
        conn.markActive();

        pool.push(conn);
        this.pools.set(key, pool);
        return conn;
    }

    release(cfg: ConnectionConfig, conn: Connection): void {
        if (conn.isClosed()) {
            this.removeConnection(cfg, conn);
            return;
        }
        conn.markIdle();
    }

    closeAll(): void {
        for (const pool of this.pools.values()) {
            for (const conn of pool) conn.close();
        }
        this.pools.clear();
    }

    getStats(): Record<string, { total: number; idle: number; active: number }> {
        const stats: Record<string, any> = {};
        for (const [key, pool] of this.pools.entries()) {
            const idle = pool.filter(c => c.state === ConnectionState.IDLE).length;
            const active = pool.filter(c => c.state === ConnectionState.ACTIVE).length;
            stats[key] = { total: pool.length, idle, active };
        }
        return stats;
    }

    private cleanupPool(key: string): void {
        const pool = this.pools.get(key);
        if (!pool) return;
        const alive = pool.filter(c => !c.isClosed());
        if (alive.length === 0) this.pools.delete(key);
        else if (alive.length < pool.length) this.pools.set(key, alive);
    }

    private removeConnection(cfg: ConnectionConfig, conn: Connection): void {
        const key = this.getKey(cfg);
        const pool = this.pools.get(key);
        if (!pool) return;
        const index = pool.indexOf(conn);
        if (index !== -1) pool.splice(index, 1);
        if (pool.length === 0) this.pools.delete(key);
    }
}

export const connectionManager = new ConnectionManager();
