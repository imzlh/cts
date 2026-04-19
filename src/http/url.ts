// URL API Polyfill for QuickJS ng
// 完整实现 URL 和 URLSearchParams，支持特殊路径格式

// ==================== 工具函数 ====================

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
const SCHEME_CHARS = ALPHA + DIGIT + '+-.';
const USERINFO_ENCODE_SET = /[^\w.~!$&'()*+,;=:-]/g;
const PATH_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/%-]/g;
const QUERY_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/?%-]/g;
const FRAGMENT_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/?%-]/g;

const isWindowsDriveLetter = (str: string): boolean => {
    return str.length === 2 &&
        /[a-zA-Z]/.test(str[0]!) &&
        (str[1] === ':' || str[1] === '|');
};

const isNormalizedWindowsPath = (str: string): boolean => {
    return /^[a-zA-Z]:[\/\\]/.test(str);
};

const isAbsolutePath = (str: string): boolean => {
    return str.startsWith('/') || isNormalizedWindowsPath(str);
};

const percentEncode = (str: string, encodeSet: RegExp): string => {
    return str.replace(encodeSet, (char) => {
        const hex = char.charCodeAt(0).toString(16).toUpperCase();
        return `%${hex.padStart(2, '0')}`;
    });
};

const percentDecode = (str: string): string => {
    return str.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    });
};

const normalizeWindowsPath = (path: string): string => {
    // C:\aaa\bbb -> C:/aaa/bbb
    // /C:\aaa -> C:/aaa
    // /C:/aaa -> C:/aaa

    path = path.replace(/\\/g, '/');

    // 移除开头的斜杠（如果后面是盘符）
    if (path.startsWith('/') && isWindowsDriveLetter(path.slice(1, 3))) {
        path = path.slice(1);
    }

    // 处理 C| 格式
    if (isWindowsDriveLetter(path.slice(0, 2)) && path[1] === '|') {
        path = path[0] + ':' + path.slice(2);
    }

    return path;
};

const normalizePath = (path: string): string => {
    // 规范化路径，处理 . 和 ..
    const parts = path.split('/');
    const result: string[] = [];

    for (const part of parts) {
        if (part === '.' || part === '') {
            continue;
        }
        if (part === '..') {
            if (result.length > 0 && result[result.length - 1] !== '..') {
                result.pop();
            } else if (!path.startsWith('/')) {
                result.push('..');
            }
        } else {
            result.push(part);
        }
    }

    const normalized = result.join('/');

    if (path.startsWith('/')) {
        return '/' + normalized;
    }

    return normalized || '.';
};

// ==================== URLSearchParams ====================

class URLSearchParams implements URLSearchParams {
    #params: Array<[string, string]> = [];
    #updateCallback?: () => void;

    constructor(init?: string | URLSearchParams | Record<string, string> | Iterable<[string, string]>) {
        if (init === undefined || init === null) {
            return;
        }

        if (typeof init === 'string') {
            this.#parseQuery(init);
        } else if (init instanceof URLSearchParams) {
            this.#params = [...init.#params];
        } else if (typeof init === 'object') {
            if (Symbol.iterator in init) {
                for (const [key, value] of init as Iterable<[string, string]>) {
                    this.#params.push([String(key), String(value)]);
                }
            } else {
                for (const [key, value] of Object.entries(init)) {
                    this.#params.push([key, String(value)]);
                }
            }
        }
    }

    #parseQuery(query: string): void {
        query = query.replace(/^\?/, '');

        if (!query) return;

        const pairs = query.split('&');
        for (const pair of pairs) {
            if (!pair) continue;

            const index = pair.indexOf('=');
            if (index === -1) {
                this.#params.push([percentDecode(pair.replace(/\+/g, ' ')), '']);
            } else {
                const key = percentDecode(pair.slice(0, index).replace(/\+/g, ' '));
                const value = percentDecode(pair.slice(index + 1).replace(/\+/g, ' '));
                this.#params.push([key, value]);
            }
        }
    }

    #notifyUpdate(): void {
        this.#updateCallback?.();
    }

    append(name: string, value: string): void {
        this.#params.push([String(name), String(value)]);
        this.#notifyUpdate();
    }

    delete(name: string, value?: string): void {
        const nameStr = String(name);

        if (value !== undefined) {
            const valueStr = String(value);
            this.#params = this.#params.filter(
                ([k, v]) => !(k === nameStr && v === valueStr)
            );
        } else {
            this.#params = this.#params.filter(([k]) => k !== nameStr);
        }

        this.#notifyUpdate();
    }

    get(name: string): string | null {
        const nameStr = String(name);
        const entry = this.#params.find(([k]) => k === nameStr);
        return entry ? entry[1] : null;
    }

    getAll(name: string): string[] {
        const nameStr = String(name);
        return this.#params
            .filter(([k]) => k === nameStr)
            .map(([, v]) => v);
    }

    has(name: string, value?: string): boolean {
        const nameStr = String(name);

        if (value !== undefined) {
            const valueStr = String(value);
            return this.#params.some(([k, v]) => k === nameStr && v === valueStr);
        }

        return this.#params.some(([k]) => k === nameStr);
    }

    set(name: string, value: string): void {
        const nameStr = String(name);
        const valueStr = String(value);

        // Remove all entries with this name, keeping the first one's position
        let found = false;
        this.#params = this.#params.filter(([k]) => {
            if (k === nameStr) {
                if (!found) { found = true; return true; }
                return false;
            }
            return true;
        });

        // Replace the first occurrence's value, or append if not found
        if (found) {
            const entry = this.#params.find(([k]) => k === nameStr);
            entry![1] = valueStr;
        } else {
            this.#params.push([nameStr, valueStr]);
        }

        this.#notifyUpdate();
    }

    sort(): void {
        this.#params.sort((a, b) => {
            if (a[0] < b[0]) return -1;
            if (a[0] > b[0]) return 1;
            return 0;
        });
        this.#notifyUpdate();
    }

    toString(): string {
        return this.#params
            .map(([key, value]) => {
                const encodedKey = percentEncode(key, /[^\w.~-]/g).replace(/%20/g, '+');
                const encodedValue = percentEncode(value, /[^\w.~-]/g).replace(/%20/g, '+');
                return `${encodedKey}=${encodedValue}`;
            })
            .join('&');
    }

    entries(): Iterator<[string, string]> {
        return this.#params[Symbol.iterator]();
    }

    keys(): Iterator<string> {
        return this.#params.map(([k]) => k)[Symbol.iterator]();
    }

    values(): Iterator<string> {
        return this.#params.map(([, v]) => v)[Symbol.iterator]();
    }

    forEach(callback: (value: string, key: string, parent: this) => void, thisArg?: any): void {
        for (const [key, value] of this.#params) {
            callback.call(thisArg, value, key, this);
        }
    }


    [Symbol.iterator](): Iterator<[string, string]> {
        return this.entries();
    }

    get size(): number {
        return this.#params.length;
    }

    _setUpdateCallback(callback: () => void): void {
        this.#updateCallback = callback;
    }

    _getParams(): Array<[string, string]> {
        return [...this.#params];
    }
}

const SPECIAL_SCHEMES: Record<string, number> = {
    'ftp': 21,
    'file': -1,
    'http': 80,
    'https': 443,
    'ws': 80,
    'wss': 443
};

class URL {
    #scheme = '';
    #username = '';
    #password = '';
    #host = '';
    #port = '';
    #path: string[] = [];
    #query: string | null = null;
    #fragment = '';
    #searchParams: URLSearchParams;

    static parse(url: string, base?: string | URL): URL | null {
        try {
            return new URL(url, base);
        } catch {
            return null;
        }
    }

    static canParse(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    constructor(url: string | URL, base?: string | URL) {
        
        
        
        this.#searchParams = new URLSearchParams();
        this.#searchParams._setUpdateCallback(() => {
            this.#query = this.#searchParams.toString();
        });

        this.#parse(String(url), base);
        
    }

    #parse(input: string, base?: string | URL): void {
        
        input = String(input).trim();

        // 处理特殊格式
        if (this.#isWindowsPath(input)) {
            
            this.#parseWindowsPath(input);
            return;
        }

        if (this.#isUnixPath(input)) {
            
            this.#parseUnixPath(input);
            return;
        }

        // 标准 URL 解析
        const baseUrl = base ? (typeof base === 'string' ? new URL(base) : base as URL) : null;

        // 提取 fragment
        const fragmentIndex = input.indexOf('#');
        if (fragmentIndex !== -1) {
            this.#fragment = input.slice(fragmentIndex + 1);
            input = input.slice(0, fragmentIndex);
            
        }

        // 提取 query
        const queryIndex = input.indexOf('?');
        if (queryIndex !== -1) {
            this.#query = input.slice(queryIndex + 1);
            input = input.slice(0, queryIndex);
            
        }

        // 解析 scheme
        const schemeMatch = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        if (schemeMatch) {
            this.#scheme = schemeMatch[1]!.toLowerCase();
            input = input.slice(schemeMatch[0].length);
            
        } else if (baseUrl) {
            this.#scheme = baseUrl.#scheme;
            
        } else {
            throw new TypeError('Invalid URL: no scheme');
        }

        // 特殊 scheme 处理
        const isSpecial = this.#scheme in SPECIAL_SCHEMES;

        // 解析 authority
        if (input.startsWith('//')) {
            input = input.slice(2);

            const authorityEnd = input.search(/[/?#]/);
            const authority = authorityEnd === -1 ? input : input.slice(0, authorityEnd);
            input = authorityEnd === -1 ? '' : input.slice(authorityEnd);

            this.#parseAuthority(authority);
        } else if (baseUrl && this.#scheme === baseUrl.#scheme) {
            // Same-scheme relative URL without authority — inherit base authority
            this.#username = baseUrl.#username;
            this.#password = baseUrl.#password;
            this.#host = baseUrl.#host;
            this.#port = baseUrl.#port;

            if (input.startsWith('/') || !input) {
                // Absolute-path or empty: replace entire path
                this.#path = [];
            } else {
                // Relative path: inherit base path directory
                this.#path = [...baseUrl.#path];
                if (this.#path.length > 0) {
                    this.#path.pop();
                }
            }
        } else if (input.startsWith('/') && isSpecial && this.#scheme !== 'file') {
            // Non-standard but tolerant: single slash after special scheme
            // (e.g., https:/example.com) — treat as path, not authority
            // This matches browser behaviour where host stays empty
        }

        // 解析 path
        if (input) {
            this.#parsePath(input, isSpecial);
        }

        // 更新 searchParams
        if (this.#query !== null) {
            this.#searchParams = new URLSearchParams(this.#query);
            this.#searchParams._setUpdateCallback(() => {
                this.#query = this.#searchParams.toString();
            });
        }
    }

    #isWindowsPath(str: string): boolean {
        return /^[a-zA-Z]:[\/\\]/.test(str) || /^[a-zA-Z]\|[\/\\]/.test(str);
    }

    #isUnixPath(str: string): boolean {
        return str.startsWith('/') && !str.startsWith('//');
    }

    #parseWindowsPath(path: string): void {
        this.#scheme = 'file';
        path = normalizeWindowsPath(path);

        // C:/aaa/bbb -> ['', 'C:', 'aaa', 'bbb']
        // The leading empty string ensures pathname starts with /
        // and toString() produces file:///C:/aaa/bbb (3 slashes)
        const parts = path.split('/');
        this.#path = [''];
        for (const p of parts) {
            if (p) this.#path.push(p);
        }
    }

    #parseUnixPath(path: string): void {
        this.#scheme = 'file';
        this.#path = path.split('/');
    }

    #parseAuthority(authority: string): void {
        // 提取 userinfo
        const atIndex = authority.lastIndexOf('@');
        if (atIndex !== -1) {
            const userinfo = authority.slice(0, atIndex);
            authority = authority.slice(atIndex + 1);

            const colonIndex = userinfo.indexOf(':');
            if (colonIndex === -1) {
                this.#username = percentDecode(userinfo);
            } else {
                this.#username = percentDecode(userinfo.slice(0, colonIndex));
                this.#password = percentDecode(userinfo.slice(colonIndex + 1));
            }
        }

        // 提取 host 和 port
        if (authority.startsWith('[')) {
            // IPv6
            const endBracket = authority.indexOf(']');
            if (endBracket === -1) {
                throw new TypeError('Invalid URL: unclosed IPv6 address');
            }
            this.#host = authority.slice(0, endBracket + 1).toLowerCase();
            authority = authority.slice(endBracket + 1);
        } else {
            const colonIndex = authority.lastIndexOf(':');
            if (colonIndex === -1) {
                this.#host = authority.toLowerCase();
            } else {
                this.#host = authority.slice(0, colonIndex).toLowerCase();
                authority = authority.slice(colonIndex);
            }
        }

        // 提取 port
        if (authority.startsWith(':')) {
            const portStr = authority.slice(1);
            if (portStr && /^\d+$/.test(portStr)) {
                const port = parseInt(portStr, 10);
                if (port <= 65535) {
                    // 只在非默认端口时设置
                    const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                    if (defaultPort !== port) {
                        this.#port = String(port);
                    }
                }
            }
        }
    }

    #parsePath(path: string, isSpecial: boolean): void {
        if (path.startsWith('/')) {
            this.#path = [];
            path = path.slice(1);
        }

        if (!path) return;

        const segments = path.split('/');
        for (const segment of segments) {
            if (segment === '.') {
                continue;
            }
            if (segment === '..') {
                if (isSpecial) {
                    // Special schemes: compress .. (cannot go above root)
                    if (this.#path.length > 0 && this.#path[this.#path.length - 1] !== '..') {
                        this.#path.pop();
                    }
                } else {
                    // Non-special schemes: preserve .. in path
                    if (this.#path.length > 0 && this.#path[this.#path.length - 1] !== '..') {
                        this.#path.pop();
                    } else {
                        this.#path.push('..');
                    }
                }
            } else {
                this.#path.push(segment);
            }
        }
    }

    // ==================== Getters ====================

    get href(): string {
        return this.toString();
    }

    set href(value: string) {
        this.#parse(value);
    }

    get origin(): string {
        if (this.#scheme === 'blob') {
            try {
                const url = new URL(this.pathname);
                return url.origin;
            } catch {
                return 'null';
            }
        }

        if (this.#scheme === 'file') {
            return 'null';
        }

        if (!(this.#scheme in SPECIAL_SCHEMES)) {
            return 'null';
        }

        let origin = `${this.#scheme}://${this.#host}`;
        if (this.#port) {
            origin += `:${this.#port}`;
        }
        return origin;
    }

    get protocol(): string {
        return this.#scheme + ':';
    }

    set protocol(value: string) {
        const scheme = String(value).replace(/:$/, '').toLowerCase();
        if (scheme && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) {
            this.#scheme = scheme;
        }
    }

    get username(): string {
        return this.#username;
    }

    set username(value: string) {
        if (this.#scheme === 'file') return;
        this.#username = percentEncode(String(value), USERINFO_ENCODE_SET);
    }

    get password(): string {
        return this.#password;
    }

    set password(value: string) {
        if (this.#scheme === 'file') return;
        this.#password = percentEncode(String(value), USERINFO_ENCODE_SET);
    }

    get host(): string {
        if (!this.#host) return '';
        return this.#port ? `${this.#host}:${this.#port}` : this.#host;
    }

    set host(value: string) {
        if (this.#scheme === 'file') return;

        const str = String(value);
        const colonIndex = str.lastIndexOf(':');

        if (colonIndex === -1) {
            this.#host = str.toLowerCase();
            this.#port = '';
        } else {
            this.#host = str.slice(0, colonIndex).toLowerCase();
            const portStr = str.slice(colonIndex + 1);
            if (/^\d+$/.test(portStr)) {
                const port = parseInt(portStr, 10);
                if (port <= 65535) {
                    const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                    this.#port = defaultPort === port ? '' : String(port);
                }
            }
        }
    }

    get hostname(): string {
        return this.#host;
    }

    set hostname(value: string) {
        if (this.#scheme === 'file') return;
        this.#host = String(value).toLowerCase();
    }

    get port(): string {
        return this.#port;
    }

    set port(value: string) {
        if (this.#scheme === 'file') return;

        const portStr = String(value);
        if (!portStr) {
            this.#port = '';
            return;
        }

        if (/^\d+$/.test(portStr)) {
            const port = parseInt(portStr, 10);
            if (port <= 65535) {
                const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                this.#port = defaultPort === port ? '' : String(port);
            }
        }
    }

    get pathname(): string {
        if (this.#scheme === 'file') {
            if (this.#path.length === 0) return '';
            return this.#path.join('/');
        }

        if (this.#path.length === 0) return '/';
        return '/' + this.#path.map(p => percentEncode(p, PATH_ENCODE_SET)).join('/');
    }

    set pathname(value: string) {
        if (this.#scheme === 'file') {
            this.#path = String(value).split('/').filter(p => p);
            return;
        }

        this.#path = [];
        this.#parsePath(String(value), this.#scheme in SPECIAL_SCHEMES);
    }

    get search(): string {
        if (this.#query === null || this.#query === '') return '';
        return '?' + this.#query;
    }

    set search(value: string) {
        const str = String(value);
        if (!str) {
            this.#query = null;
            this.#searchParams = new URLSearchParams();
            this.#searchParams._setUpdateCallback(() => {
                this.#query = this.#searchParams.toString();
            });
            return;
        }

        this.#query = str.startsWith('?') ? str.slice(1) : str;
        this.#searchParams = new URLSearchParams(this.#query);
        this.#searchParams._setUpdateCallback(() => {
            this.#query = this.#searchParams.toString();
        });
    }

    get searchParams(): URLSearchParams {
        return this.#searchParams;
    }

    get hash(): string {
        if (!this.#fragment) return '';
        return '#' + this.#fragment;
    }

    set hash(value: string) {
        const str = String(value);
        if (!str) {
            this.#fragment = '';
            return;
        }
        this.#fragment = percentEncode(
            str.startsWith('#') ? str.slice(1) : str,
            FRAGMENT_ENCODE_SET
        );
    }

    // ==================== 方法 ====================

    toString(): string {
        let result = this.#scheme + ':';


        if (this.#host || this.#scheme === 'file') {
            if (this.#scheme === 'file') {
                // file:// is always present; pathname already includes leading /
                // e.g. pathname = /C:/aaa/bbb -> file:///C:/aaa/bbb
                // e.g. pathname = /aaa/bbb   -> file:///aaa/bbb
                result += '//' + this.pathname;

                if (this.#query !== null && this.#query !== '') {
                    result += '?' + this.#query;
                }
                if (this.#fragment) {
                    result += '#' + this.#fragment;
                }
                return result;
            } else {
                result += '//';
            }
            
            if (this.#username || this.#password) {
                result += percentEncode(this.#username, USERINFO_ENCODE_SET);
                if (this.#password) {
                    result += ':' + percentEncode(this.#password, USERINFO_ENCODE_SET);
                }
                result += '@';
            }

            result += this.#host;

            if (this.#port) {
                result += ':' + this.#port;
            }
        }

        result += this.pathname;

        if (this.#query !== null && this.#query !== '') {
            result += '?' + this.#query;
        }

        if (this.#fragment) {
            result += '#' + this.#fragment;
        }

        return result;
    }

    toJSON(): string {
        return this.toString();
    }

    static createObjectURL(blob: any): string {
        throw new Error('createObjectURL is not implemented');
    }

    static revokeObjectURL(url: string): void {
        throw new Error('revokeObjectURL is not implemented');
    }
}

Reflect.set(globalThis, 'URL', URL);
Reflect.set(globalThis, 'URLSearchParams', URLSearchParams);

export {
    URL as URL,
    URLSearchParams as URLSearchParams
};