/**
 * HTTP 消息构建与解析
 * 支持 Request/Response 的构建、解析和流式处理
 */

import { Headers } from "headers-polyfill";
import { URL } from "./url";
import { err, ErrorKind } from '../errors';
import { assert, engine, http } from '../utils/index';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;
type HeadersInit = Record<string, string | string[]>;
type BodyInit = ArrayBuffer | Uint8Array | string;

/**
 * HTTP 方法
 */
export type HttpMethod =
    | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
    | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE' | string;

/**
 * HTTP 版本
 */
export type HttpVersion = '1.0' | '1.1';

/**
 * HTTP 请求初始化选项
 */
export interface ReqInit {
    method?: HttpMethod;
    version?: HttpVersion;
    headers?: HeadersInit;
    body?: BodyInit | null;
}

/**
 * HTTP 请求构建器
 */
export class HttpRequestBuilder {
    private method: HttpMethod = 'GET';
    private version: HttpVersion = '1.1';
    private url: URL;
    private headers: Headers = new Headers();
    private body: Uint8Array | null = null;

    constructor(url: string | URL, options?: ReqInit) {
        this.url = typeof url === 'string' ? new URL(url) : url;

        if (options?.method) {
            this.method = options.method.toUpperCase() as HttpMethod;
        }

        if (options?.version) {
            this.version = options.version;
        }

        if (options?.headers) {
            this.headers = new Headers(options.headers);
        }

        if (options?.body !== undefined && options?.body !== null) {
            this.setBody(options.body);
        }
    }

    /**
     * 设置请求体
     */
    private setBody(body: BodyInit): void {
        if (body instanceof Uint8Array) {
            if (body.buffer instanceof SharedArrayBuffer)
                throw err(ErrorKind.InvalidSpecifier, 'SharedArrayBuffer is not supported here');
            // @ts-ignore
            this.body = body;
        } else if (body instanceof ArrayBuffer) {
            this.body = new Uint8Array(body);
        } else if (typeof body === 'string') {
            this.body = engine.encodeString(body);
        } else {
            // 假设是 JSON 可序列化对象
            this.body = engine.encodeString(JSON.stringify(body));
            if (!this.headers.has('content-type')) {
                this.headers.set('content-type', 'application/json');
            }
        }
    }

    /**
     * 构建 HTTP 请求（同步）
     */
    build(): Uint8Array {
        // 设置默认头部
        if (!this.headers.has('host')) {
            this.headers.set('host', this.url.host);
        }

        if (this.body && !this.headers.has('content-length')) {
            this.headers.set('content-length', String(this.body.length));
        }

        if (!this.headers.has('user-agent')) {
            this.headers.set('user-agent', 'circu.js/cno');
        }

        // HTTP/1.0 defaults to Connection: close; HTTP/1.1 defaults to keep-alive
        // Only set if not already specified by the caller
        if (!this.headers.has('connection')) {
            this.headers.set('connection', this.version === '1.0' ? 'close' : 'keep-alive');
        }

        // 构建请求行
        const path = this.url.pathname + this.url.search;
        let request = `${this.method} ${path} HTTP/${this.version}\r\n`;

        for (const [key, value] of this.headers) {
            request += `${key}: ${value}\r\n`;
        }

        // 结束头部
        request += '\r\n';

        // 转换为字节
        const headerBytes = engine.encodeString(request);

        // 如果有请求体，合并
        if (this.body) {
            const combined = new Uint8Array(headerBytes.length + this.body.length);
            combined.set(headerBytes, 0);
            combined.set(this.body, headerBytes.length);
            // console.debug(`[http.build] WRITE: ${this.body.length} bytes body`);
            return combined;
        }

        return headerBytes;
    }

    /**
     * 获取头部
     */
    getHeaders(): Headers {
        return this.headers;
    }

    /**
     * 获取请求体
     */
    getBody(): Uint8Array | null {
        return this.body;
    }
}

/**
 * HTTP 响应解析器
 */
export class HttpResponseParser {
    private parser: CModuleHTTP.Parser;
    private statusCode: number = 0;
    private statusText: string = '';
    private httpVersion: string = '1.1';
    private headers: Headers = new Headers();
    private bodyChunks: Uint8Array[] = [];
    private currentHeaderField: string = '';
    private completed: boolean = false;
    private headersComplete: boolean = false;

    // 回调钩子
    public onHeadersComplete?: (statusCode: number, headers: Headers) => void;
    public onData?: (chunk: Uint8Array) => void;
    public onComplete?: () => void;
    public onError?: (error: Error) => void;

    constructor() {
        this.parser = new http.Parser(http.RESPONSE);
        this.setupCallbacks();
    }

    /**
     * 设置解析器回调
     */
    private setupCallbacks(): void {
        // 状态行
        this.parser.onStatus = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            this.statusText = engine.decodeString(view);
        };

        // 头部字段名
        this.parser.onHeaderField = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            this.currentHeaderField = engine.decodeString(view).toLowerCase();
        };

        // 头部值
        this.parser.onHeaderValue = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            const value = engine.decodeString(view);
            this.headers.append(this.currentHeaderField, value);
            this.currentHeaderField = '';
        };

        // 头部完成
        this.parser.onHeadersComplete = () => {
            // update status
            this.statusCode = this.parser.state.status;
            this.headersComplete = true;
            if (!this.statusText) {
                this.statusText = http.strstatus(this.statusCode);
            }
            // Detect HTTP version from parser state
            // The http_parser sets http_major and http_minor fields
            const major = (this.parser.state as any).http_major ?? 1;
            const minor = (this.parser.state as any).http_minor ?? 1;
            this.httpVersion = `${major}.${minor}`;
            this.onHeadersComplete?.(this.statusCode, this.headers);
        };

        // 响应体数据
        this.parser.onBody = (buf, off, len) => {
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            if (!this.onData) this.bodyChunks.push(view);    // 缓存
            this.onData?.(view);
        };

        // 消息完成
        this.parser.onMessageComplete = () => {
            this.completed = true;
            this.onComplete?.();
        };
    }

    /**
     * 喂入数据
     */
    feed(data: Uint8Array): void {
        try {
            const result = this.parser.execute(data.buffer.slice(data.byteOffset, data.length + data.byteOffset));

            if (result.errno !== 0) {
                const error = new Error(`HTTP parse error: ${result.reason}`);
                if (this.onError) {
                    this.onError(error);
                } else {
                    throw error;
                }
            }
        } catch (err) {
            if (this.onError) {
                this.onError(err as Error);
            } else {
                throw err;
            }
        }
    }

    /**
     * 获取状态码
     */
    getStatusCode(): number {
        assert(this.statusCode, "Response not completed");
        return this.statusCode;
    }

    /**
     * 获取 HTTP 版本 (e.g., "1.0", "1.1")
     */
    getHttpVersion(): string {
        return this.httpVersion;
    }

    /**
     * 是否为 HTTP/1.0 响应
     */
    get isHttp10(): boolean {
        return this.httpVersion === '1.0';
    }

    /**
     * 获取状态文本
     */
    getStatusText(): string {
        assert(this.statusCode, "Response not completed");
        return this.statusText || "Unknown";
    }

    /**
     * 获取头部
     */
    getHeaders(): Headers {
        assert(this.statusCode, "Response not completed");
        return this.headers;
    }

    getBodyChunks(): Uint8Array[] {
        const t = this.bodyChunks;
        this.bodyChunks = [];
        return t;
    }

    /**
     * 检查是否完成
     */
    get isCompleted(): boolean {
        return this.completed;
    }

    /**
     * 检查头部是否完成
     */
    get isHeadersComplete(): boolean {
        return this.headersComplete;
    }

    /**
     * 重置解析器
     */
    reset(): void {
        this.parser.reset(http.RESPONSE);
        this.statusCode = 0;
        this.statusText = '';
        this.httpVersion = '1.1';
        this.headers = new Headers();
        this.bodyChunks = [];
        this.currentHeaderField = '';
        this.completed = false;
        this.headersComplete = false;

        // 重置回调
        this.onComplete = this.onData =
            this.onError = this.onHeadersComplete = undefined;
    }
}

/**
 * 解析 URL
 */
export function parseURL(url: string, base?: string): URL {
    try {
        return new URL(url, base);
    } catch (err) {
        throw err(ErrorKind.InvalidSpecifier, `Invalid URL: ${url}`);
    }
}

/**
 * 规范化 HTTP 方法
 */
export function normalizeMethod(method: string): HttpMethod {
    const normalized = method.toUpperCase();
    const validMethods: HttpMethod[] = [
        'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
        'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'
    ];

    if (!validMethods.includes(normalized as HttpMethod)) {
        throw err(ErrorKind.InvalidSpecifier, `Invalid HTTP method: ${method}`);
    }

    return normalized as HttpMethod;
}

/**
 * 解析 Content-Type
 */
export function parseContentType(contentType: string): {
    type: string;
    parameters: Map<string, string>;
} {
    const parts = contentType.split(';').map(p => p.trim());
    const type = parts[0]!.toLowerCase();
    const parameters = new Map<string, string>();

    for (let i = 1; i < parts.length; i++) {
        const [key, value] = parts[i]!.split('=').map(p => p.trim());
        if (key && value) {
            parameters.set(key.toLowerCase(), value.replace(/^["']|["']$/g, ''));
        }
    }

    return { type, parameters };
}

/**
 * 判断状态码是否表示重定向
 */
export function isRedirect(statusCode: number): boolean {
    return statusCode >= 300 && statusCode < 400;
}

/**
 * 判断状态码是否表示成功
 */
export function isSuccess(statusCode: number): boolean {
    return statusCode >= 200 && statusCode < 300;
}

/**
 * 判断是否需要请求体
 */
export function methodHasBody(method: HttpMethod): boolean {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}