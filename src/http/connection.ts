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

import { hexDump } from "./debug";

const streams = import.meta.use("streams");
const ssl     = import.meta.use("ssl");
const dns     = import.meta.use("dns");
const os      = import.meta.use("os");
const timers  = import.meta.use("timers");
const fs      = import.meta.use("fs");
const console = import.meta.use("console");

// Local assertion function to avoid circular dependency
function assert(condition: any, message?: string): asserts condition {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* Configuration & State                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Single Connection                                                  */
/* ------------------------------------------------------------------ */

export class Connection implements ConnectionLike {
    public socket:   CModuleStreams.TCP;
    public sslPipe:  CModuleSSL.Pipe | null = null;
    public state:    ConnectionState        = ConnectionState.CONNECTING;
    public lastUsed: number                 = Date.now();
    public requests: number                 = 0;

    private idleTimer: number | null = null;
    private config: ConnectionConfig;
    
    // Buffer for unfed ciphertext when SSL pipe is full
    private pendingCiphertext: Uint8Array | null = null;

    constructor(cfg: ConnectionConfig) {
        this.config = cfg;
        this.socket = new streams.TCP();
    }

    /* -------------------------------------------------------------- */
    /* Public API                                                     */
    /* -------------------------------------------------------------- */
    connect(): void {
        try {
            console.debug(`[Connection] Connecting to ${this.config.hostname}:${this.config.port} via ${this.config.protocol}`);
            
            // DNS resolution
            console.debug(`[Connection] Resolving DNS for ${this.config.hostname}`);
            const addrs = dns.resolveSync(this.config.hostname, { family: os.AF_UNSPEC });
            if (!addrs || !addrs.length) {
                throw new Error(`DNS resolution failed for ${this.config.hostname}`);
            }
            console.debug(`[Connection] DNS resolved to ${addrs.length} addresses:`, addrs.map(a => `${a.ip} (${a.family === 4 ? 'IPv4' : 'IPv6'})`));

            // Prefer IPv4
            const addr = addrs.find(a => a.family === 4) || addrs[0];
            assert(addr, `No IP address found for ${this.config.hostname}`);
            console.debug(`[Connection] Using address: ${addr.ip} (${addr.family === 4 ? 'IPv4' : 'IPv6'})`);

            // TCP connect
            console.debug(`[Connection] Establishing TCP connection to ${addr.ip}:${this.config.port}`);
            this.socket.connectSync({ ip: addr.ip, port: this.config.port });
            console.debug(`[Connection] TCP connection established`);

            // TLS handshake if HTTPS
            if (this.config.protocol === "https:") {
                console.debug(`[Connection] Starting TLS handshake`);
                this.performTLSHandshake();
                console.debug(`[Connection] TLS handshake completed`);
            }

            this.state = ConnectionState.IDLE;
            this.startIdleTimer();
            console.debug(`[Connection] Connection setup complete, state: ${this.state}`);
        } catch (err) {
            console.error(`[Connection:ERROR] Connection failed:`, err);
            this.state = ConnectionState.CLOSED;
            try {
                this.socket.close();
            } catch {}
            throw err;
        }
    }

    write(data: Uint8Array) {
        if (this.sslPipe) {
            // SSL mode: encrypt plaintext
            const written = this.sslPipe.write(data);
            
            if (written < 0) {
                throw new Error(`SSL_write failed: ${written}`);
            }
            console.debug(`[Connection] SSL_write consumed ${written} bytes`);

            // Send encrypted data to network
            const encrypted = this.sslPipe.getOutput();
            if (encrypted) {
                this.socket.writeSync(new Uint8Array(encrypted));
            }
        } else {
            // Plain HTTP: write directly
            this.socket.writeSync(data);
        }
    }

    read(size = 16384, waitForData = false): Uint8Array | null {
        if (this.sslPipe) {
            return this.readSSL(size, waitForData);
        } else {
            return this.readPlain(size, waitForData);
        }
    }

    /* -------------------------------------------------------------- */
    /* SSL Read Logic                                                 */
    /* -------------------------------------------------------------- */
    
    private readSSL(size: number, waitForData: boolean): Uint8Array | null {
        console.debug(`[Connection] readSSL: size=${size}, waitForData=${waitForData}`);
        
        const maxAttempts = waitForData ? 10 : 1;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Step 1: Process any pending ciphertext first
            if (this.pendingCiphertext && this.pendingCiphertext.length > 0) {
                console.debug(`[Connection] Processing ${this.pendingCiphertext.length} bytes pending ciphertext`);
                const consumed = this.feedCiphertext(this.pendingCiphertext);
                
                if (consumed > 0) {
                    if (consumed < this.pendingCiphertext.length) {
                        this.pendingCiphertext = this.pendingCiphertext.subarray(consumed);
                        console.debug(`[Connection] ${this.pendingCiphertext.length} bytes still pending`);
                    } else {
                        this.pendingCiphertext = null;
                        console.debug(`[Connection] All pending ciphertext consumed`);
                    }
                }
            }
            
            // Step 2: Try to read plaintext from SSL pipe
            const plaintext = this.sslPipe!.read(size);
            if (plaintext && plaintext.byteLength > 0) {
                console.debug(`[Connection] Got ${plaintext.byteLength} bytes plaintext`);
                return new Uint8Array(plaintext);
            }
            
            // Step 3: If SSL pipe has no plaintext, read more ciphertext from socket
            const cipherBuf = new Uint8Array(size);
            const n = this.socket.readSync(cipherBuf);
            
            // Handle socket read result
            if (n === null) {
                // EOF - connection closed by peer
                console.debug(`[Connection] Socket EOF (attempt ${attempt + 1})`);
                return null;
            }
            
            if (n === 0) {
                // EAGAIN - no data available right now
                console.debug(`[Connection] Socket EAGAIN (attempt ${attempt + 1})`);
                
                if (!waitForData) {
                    // Not waiting, return immediately
                    // Check if we have any plaintext after processing pending
                    const finalPlaintext = this.sslPipe!.read(size);
                    if (finalPlaintext && finalPlaintext.byteLength > 0) {
                        console.debug(`[Connection] Got ${finalPlaintext.byteLength} bytes plaintext from pending`);
                        return new Uint8Array(finalPlaintext);
                    }
                    return null;
                }
                
                // Wait a bit before retry
                if (attempt < maxAttempts - 1) {
                    this.sleep(50);
                }
                continue;
            }
            
            // Step 4: Feed new ciphertext to SSL pipe
            console.debug(`[Connection] Read ${n} bytes ciphertext from socket`);
            const ciphertext = cipherBuf.subarray(0, n);
            const consumed = this.feedCiphertext(ciphertext);
            
            if (consumed < ciphertext.length) {
                // Store unfed portion
                const unfed = ciphertext.subarray(consumed);
                if (this.pendingCiphertext) {
                    // Merge with existing pending
                    const merged = new Uint8Array(this.pendingCiphertext.length + unfed.length);
                    merged.set(this.pendingCiphertext);
                    merged.set(unfed, this.pendingCiphertext.length);
                    this.pendingCiphertext = merged;
                } else {
                    this.pendingCiphertext = unfed;
                }
                console.debug(`[Connection] ${this.pendingCiphertext.length} bytes pending after feed`);
            }
            
            // Step 5: Try reading plaintext again after feeding
            const newPlaintext = this.sslPipe!.read(size);
            if (newPlaintext && newPlaintext.byteLength > 0) {
                console.debug(`[Connection] Got ${newPlaintext.byteLength} bytes plaintext after feed`);
                return new Uint8Array(newPlaintext);
            }
            
            // If not waiting and no plaintext available, return null
            if (!waitForData) {
                console.debug(`[Connection] No plaintext available, not waiting`);
                return null;
            }
            
            // Continue loop to try again
            console.debug(`[Connection] No plaintext yet, retrying (attempt ${attempt + 1}/${maxAttempts})`);
        }
        
        // Exhausted all attempts
        console.debug(`[Connection] No data after ${maxAttempts} attempts`);
        return null;
    }

    /* -------------------------------------------------------------- */
    /* Plain HTTP Read Logic                                          */
    /* -------------------------------------------------------------- */
    
    private readPlain(size: number, waitForData: boolean): Uint8Array | null {
        console.debug(`[Connection] readPlain: size=${size}, waitForData=${waitForData}`);
        
        const buf = new Uint8Array(size);
        const n = this.socket.readSync(buf);
        
        if (n === null) {
            // EOF
            console.debug(`[Connection] Plain socket EOF`);
            return null;
        }
        
        if (n === 0) {
            // EAGAIN
            console.debug(`[Connection] Plain socket EAGAIN`);
            
            if (!waitForData) {
                return null;
            }
            
            // Retry with delays
            for (let i = 0; i < 3; i++) {
                this.sleep(50);
                
                const retryN = this.socket.readSync(buf);
                if (retryN === null) {
                    console.debug(`[Connection] Plain socket EOF on retry ${i + 1}`);
                    return null;
                }
                if (retryN > 0) {
                    console.debug(`[Connection] Got ${retryN} bytes on retry ${i + 1}`);
                    return buf.subarray(0, retryN);
                }
            }
            
            // Still no data
            return null;
        }
        
        // Got data
        console.debug(`[Connection] Read ${n} bytes from plain socket`);
        return buf.subarray(0, n);
    }

    /* -------------------------------------------------------------- */
    /* Connection State Management                                    */
    /* -------------------------------------------------------------- */

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
            if (this.sslPipe) {
                this.sslPipe.shutdown();
            }
            this.socket.close();
        } catch (err) {
            // Ignore close errors
        }

        this.state = ConnectionState.CLOSED;
        this.pendingCiphertext = null;
    }

    isAvailable(): boolean {
        return this.state === ConnectionState.IDLE;
    }

    isClosed(): boolean {
        return this.state === ConnectionState.CLOSED;
    }

    /* -------------------------------------------------------------- */
    /* TLS Handshake                                                  */
    /* -------------------------------------------------------------- */
    
    private performTLSHandshake(): void {
        // Find system CA bundle
        const caPath = this.findSystemCaPathSync();
        
        // Create SSL context
        const ctx = new ssl.Context({
            mode  : "client",
            verify: !!caPath,
            ca    : caPath ?? undefined
        });
        
        if (!caPath) {
            console.warn("No system CA bundle found - disabling certificate verification");
        }

        // Create SSL pipe
        this.sslPipe = new ssl.Pipe(ctx, { servername: this.config.hostname });

        // Start handshake (generates ClientHello)
        this.sslPipe.handshake();
        
        // Send initial handshake data
        const initialData = this.sslPipe.getOutput();
        if (initialData) {
            this.socket.writeSync(new Uint8Array(initialData));
        }

        // Complete handshake loop
        while (!this.sslPipe.handshakeComplete) {
            // Read server response
            const buf = new Uint8Array(16384);
            const n = this.socket.readSync(buf);
            
            if (n === null) {
                throw new Error("TLS handshake failed: connection closed (EOF)");
            }
            
            if (n === 0) {
                throw new Error("TLS handshake failed: no data available (EAGAIN)");
            }

            // Feed server data to SSL pipe
            let toFeed = buf.subarray(0, n);
            while (toFeed.length > 0) {
                const consumed = this.feedCiphertext(toFeed);
                
                if (consumed === 0) {
                    // BIO buffer full, this shouldn't happen during handshake
                    // but we can try to advance the handshake state
                    break;
                }
                
                if (consumed < 0) {
                    throw new Error(`SSL feed failed during handshake: consumed=${consumed}`);
                }
                
                toFeed = toFeed.subarray(consumed);
            }

            // Advance handshake state machine
            this.sslPipe.handshake();

            // Send handshake response if any
            const responseData = this.sslPipe.getOutput();
            if (responseData) {
                this.socket.writeSync(new Uint8Array(responseData));
            }
        }
    }

    /* -------------------------------------------------------------- */
    /* SSL Pipe Helpers                                               */
    /* -------------------------------------------------------------- */

    /**
     * Feed ciphertext to SSL pipe
     * Returns: number of bytes consumed (may be < data.length)
     * 
     * Return values:
     * - > 0: bytes written to BIO
     * - 0: BIO buffer full (try again later)
     * - < 0: error
     */
    private feedCiphertext(data: Uint8Array): number {
        if (!this.sslPipe) return 0;
        
        const consumed = this.sslPipe.feed(data);
        
        if (consumed < 0) {
            throw new Error(`SSL feed error: ${consumed}`);
        }
        
        console.debug(`[Connection] Fed ${consumed}/${data.length} bytes to SSL pipe`);
        return consumed;
    }

    /* -------------------------------------------------------------- */
    /* Utility Methods                                                */
    /* -------------------------------------------------------------- */

    /**
     * Sleep for specified milliseconds (blocking)
     */
    private sleep(ms: number): void {
        const start = Date.now();
        while (Date.now() - start < ms) {
            // Busy wait - in a real implementation, you'd want to use
            // a proper async sleep or libuv's event loop
        }
    }

    /* -------------------------------------------------------------- */
    /* CA Certificate Discovery                                       */
    /* -------------------------------------------------------------- */

    private findSystemCaPathSync(): string | null {
        const candidates = (() => {
            switch (os.uname().sysname) {
                case "Linux":
                    return [
                        "/etc/ssl/certs/ca-certificates.crt",
                        "/etc/pki/tls/certs/ca-bundle.crt",
                        "/etc/ssl/ca-bundle.pem",
                        "/etc/pki/tls/cert.pem",
                        "/etc/ssl/cert.pem"
                    ];
                case "Darwin":
                    return [
                        "/etc/ssl/cert.pem",
                        "/usr/local/etc/openssl/cert.pem",
                        "/opt/homebrew/etc/openssl/cert.pem"
                    ];
                case "Windows_NT":
                    return [
                        "C:\\Windows\\cacert.pem",
                        "C:\\Program Files\\OpenSSL-Win64\\bin\\curl-ca-bundle.crt",
                        "C:\\Program Files\\Git\\mingw64\\ssl\\cert.pem"
                    ];
                default:
                    return [];
            }
        })();

        for (const path of candidates) {
            try {
                const stat = fs.stat(path);
                if (stat.isFile) {
                    return path;
                }
            } catch (err) {
                // File doesn't exist, try next
            }
        }

        return null;
    }

    /* -------------------------------------------------------------- */
    /* Idle Timeout Management                                        */
    /* -------------------------------------------------------------- */

    private startIdleTimer(): void {
        if (!this.config.keepAlive) return;
        
        this.stopIdleTimer();
        
        const timeout = this.config.keepAliveTimeout || 5000;
        this.idleTimer = timers.setTimeout(() => {
            if (this.state === ConnectionState.IDLE) {
                this.close();
            }
        }, timeout);
    }

    private stopIdleTimer(): void {
        if (this.idleTimer !== null) {
            timers.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}

/* ------------------------------------------------------------------ */
/* Connection Pool Manager                                            */
/* ------------------------------------------------------------------ */

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
            if (conn.state === ConnectionState.IDLE) {
                conn.close();
            }
        }
    }

    acquire(cfg: ConnectionConfig): Connection {
        const fullCfg = { ...this.defaultConfig, ...cfg } as ConnectionConfig;
        const key = this.getKey(fullCfg);

        // Clean up closed connections
        this.cleanupPool(key);

        // Try to reuse an idle connection
        const pool = this.pools.get(key) || [];
        const available = pool.find(c => c.isAvailable());
        
        if (available) {
            available.markActive();
            return available;
        }

        // Check pool size limit
        const maxSockets = fullCfg.maxSockets || 10;
        if (pool.length >= maxSockets) {
            this.closeIdleConnections(key);
        }

        // Create new connection
        const conn = new Connection(fullCfg);
        conn.connect();
        conn.markActive();

        // Add to pool
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
            for (const conn of pool) {
                conn.close();
            }
        }
        this.pools.clear();
    }

    getStats(): Record<string, { total: number; idle: number; active: number }> {
        const stats: Record<string, any> = {};

        for (const [key, pool] of this.pools.entries()) {
            const idle = pool.filter(c => c.state === ConnectionState.IDLE).length;
            const active = pool.filter(c => c.state === ConnectionState.ACTIVE).length;

            stats[key] = {
                total: pool.length,
                idle,
                active
            };
        }

        return stats;
    }

    private cleanupPool(key: string): void {
        const pool = this.pools.get(key);
        if (!pool) return;

        const alive = pool.filter(c => !c.isClosed());

        if (alive.length === 0) {
            this.pools.delete(key);
        } else if (alive.length < pool.length) {
            this.pools.set(key, alive);
        }
    }

    private removeConnection(cfg: ConnectionConfig, conn: Connection): void {
        const key = this.getKey(cfg);
        const pool = this.pools.get(key);
        if (!pool) return;

        const index = pool.indexOf(conn);
        if (index !== -1) {
            pool.splice(index, 1);
        }

        if (pool.length === 0) {
            this.pools.delete(key);
        }
    }
}

export const connectionManager = new ConnectionManager();