const USERINFO_ENCODE_SET = /[^\w.~!$&'()*+,;=:-]/g;
const PATH_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/%-]/g;
const FRAGMENT_ENCODE_SET = /[^\w.~!$&'()*+,;=:@\/?%-]/g;

const isWindowsDriveLetter = (str: string): boolean => {
    return str.length === 2 &&
        /[a-zA-Z]/.test(str[0]!) &&
        (str[1] === ':' || str[1] === '|');
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

const formUrlEncode = (str: string): string => {
    return encodeURIComponent(str)
        .replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/%20/g, '+');
};

const formUrlDecode = (str: string): string => {
    const normalized = str.replace(/\+/g, ' ').replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
    try {
        return decodeURIComponent(normalized);
    } catch {
        return percentDecode(str.replace(/\+/g, ' '));
    }
};

const isIterable = (value: unknown): value is Iterable<unknown> => {
    if (value === null || value === undefined) return false;
    const iterator = Reflect.get(Object(value), Symbol.iterator);
    return typeof iterator === 'function';
};

function requireArguments(name: string, actual: number, required: number): void {
    if (actual >= required) return;
    throw new TypeError(`${name} requires at least ${required} argument${required === 1 ? '' : 's'}`);
}

const normalizeWindowsPath = (path: string): string => {
    // C:\aaa\bbb -> C:/aaa/bbb
    // /C:\aaa -> C:/aaa
    // /C:/aaa -> C:/aaa

    path = path.replace(/\\/g, '/');

    // Remove leading slash (if followed by a drive letter)
    if (path.startsWith('/') && isWindowsDriveLetter(path.slice(1, 3))) {
        path = path.slice(1);
    }

    // Handle C| format
    if (isWindowsDriveLetter(path.slice(0, 2)) && path[1] === '|') {
        path = path[0] + ':' + path.slice(2);
    }

    return path;
};


// ==================== URLSearchParams ====================

class URLSearchParams {
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
            if (isIterable(init)) {
                for (const pair of init) {
                    if (!isIterable(pair)) throw new TypeError('Each query pair must be iterable');
                    const values = [...pair];
                    if (values.length !== 2) {
                        throw new TypeError('Each query pair must contain exactly two items');
                    }
                    this.#params.push([String(values[0]), String(values[1])]);
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
                this.#params.push([formUrlDecode(pair), '']);
            } else {
                const key = formUrlDecode(pair.slice(0, index));
                const value = formUrlDecode(pair.slice(index + 1));
                this.#params.push([key, value]);
            }
        }
    }

    #notifyUpdate(): void {
        this.#updateCallback?.();
    }

    append(name: string, value: string): void {
        requireArguments('URLSearchParams.append', arguments.length, 2);
        this.#params.push([String(name), String(value)]);
        this.#notifyUpdate();
    }

    delete(name: string, value?: string): void {
        requireArguments('URLSearchParams.delete', arguments.length, 1);
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
        requireArguments('URLSearchParams.get', arguments.length, 1);
        const nameStr = String(name);
        const entry = this.#params.find(([k]) => k === nameStr);
        return entry ? entry[1] : null;
    }

    getAll(name: string): string[] {
        requireArguments('URLSearchParams.getAll', arguments.length, 1);
        const nameStr = String(name);
        return this.#params
            .filter(([k]) => k === nameStr)
            .map(([, v]) => v);
    }

    has(name: string, value?: string): boolean {
        requireArguments('URLSearchParams.has', arguments.length, 1);
        const nameStr = String(name);

        if (value !== undefined) {
            const valueStr = String(value);
            return this.#params.some(([k, v]) => k === nameStr && v === valueStr);
        }

        return this.#params.some(([k]) => k === nameStr);
    }

    set(name: string, value: string): void {
        requireArguments('URLSearchParams.set', arguments.length, 2);
        const nameStr = String(name);
        const valueStr = String(value);

        let found = false;
        this.#params = this.#params.filter(([k]) => {
            if (k === nameStr) {
                if (!found) {
                    found = true;
                    return true;
                }
                return false;
            }
            return true;
        });

        if (found) {
            const index = this.#params.findIndex(([k]) => k === nameStr);
            this.#params[index] = [nameStr, valueStr];
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
                const encodedKey = formUrlEncode(key);
                const encodedValue = formUrlEncode(value);
                return `${encodedKey}=${encodedValue}`;
            })
            .join('&');
    }

    *entries(): IterableIterator<[string, string]> {
        let index = 0;
        while (index < this.#params.length) {
            const [key, value] = this.#params[index]!;
            index++;
            yield [key, value];
        }
    }

    *keys(): IterableIterator<string> {
        let index = 0;
        while (index < this.#params.length) {
            const [key] = this.#params[index]!;
            index++;
            yield key;
        }
    }

    *values(): IterableIterator<string> {
        let index = 0;
        while (index < this.#params.length) {
            const [, value] = this.#params[index]!;
            index++;
            yield value;
        }
    }

    forEach(callback: (value: string, key: string, parent: this) => void, thisArg?: unknown): void {
        requireArguments('URLSearchParams.forEach', arguments.length, 1);
        for (const [key, value] of this.#params) {
            callback.call(thisArg, value, key, this);
        }
    }


    [Symbol.iterator](): IterableIterator<[string, string]> {
        return this.entries();
    }

    get size(): number {
        return this.#params.length;
    }

    _setUpdateCallback(callback: () => void): void {
        this.#updateCallback = callback;
    }

    _replaceFromQuery(query: string): void {
        this.#params = [];
        this.#parseQuery(query);
    }

    _getParams(): Array<[string, string]> {
        return [...this.#params];
    }
    
    get [Symbol.toStringTag]() {
        return 'URLSearchParams';
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

export class URL {
    #scheme = '';
    #username = '';
    #password = '';
    #host = '';
    #port = '';
    #path: string[] = [];
    #hasQuery = false;
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

    static canParse(url: string, base?: string): boolean {
        try {
            new URL(url, base);
            return true;
        } catch {
            return false;
        }
    }

    constructor(url: string | URL, base?: string | URL) {
        this.#searchParams = new URLSearchParams();
        this.#searchParams._setUpdateCallback(() => {
            this.#query = this.#searchParams.toString();
            this.#hasQuery = this.#query !== '';
        });

        this.#parse(String(url), base);
    }

    #parse(input: string, base?: string | URL): void {
        input = String(input).trim();

        // Standard URL parsing
        const baseUrl = base ? (typeof base === 'string' ? new URL(base) : base as URL) : null;

        // Handle special formats (only when there is no base URL)
        if (!baseUrl) {
            if (this.#isWindowsPath(input)) {
                this.#parseWindowsPath(input);
                return;
            }

            if (this.#isUnixPath(input)) {
                this.#parseUnixPath(input);
                return;
            }
        }

        // Extract fragment
        const fragmentIndex = input.indexOf('#');
        if (fragmentIndex !== -1) {
            this.#fragment = input.slice(fragmentIndex + 1);
            input = input.slice(0, fragmentIndex);
        }

        // Extract query
        const queryIndex = input.indexOf('?');
        if (queryIndex !== -1) {
            this.#hasQuery = true;
            this.#query = input.slice(queryIndex + 1);
            input = input.slice(0, queryIndex);
        }

        // Parse scheme
        const schemeMatch = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        if (schemeMatch) {
            this.#scheme = schemeMatch[1]!.toLowerCase();
            input = input.slice(schemeMatch[0].length);
            while (input.startsWith(':')) {
                input = input.slice(1);
            }
        } else if (baseUrl) {
            this.#scheme = baseUrl.#scheme;
        } else {
            throw new TypeError('Invalid URL: no scheme');
        }

        // Special scheme handling
        const isSpecial = this.#scheme in SPECIAL_SCHEMES;

        // Parse authority
        if (input.startsWith('//')) {
            input = input.slice(2);

            const authorityEnd = input.search(/[/?#]/);
            const authority = authorityEnd === -1 ? input : input.slice(0, authorityEnd);
            input = authorityEnd === -1 ? '' : input.slice(authorityEnd);

            this.#parseAuthority(authority);
        } else if (baseUrl && this.#scheme === baseUrl.#scheme) {
            this.#username = baseUrl.#username;
            this.#password = baseUrl.#password;
            this.#host = baseUrl.#host;
            this.#port = baseUrl.#port;
            this.#path = [...baseUrl.#path];
            if (input && !input.startsWith('/')) {
                if (this.#path.length > 0) {
                    this.#path.pop();
                }
            }
        }

        // Parse path
        if (input) {
            this.#parsePath(input, isSpecial);
        }

        // Update searchParams
        if (this.#query !== null) {
            this.#searchParams._replaceFromQuery(this.#query);
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

        // C:/aaa/bbb -> /C:/aaa/bbb
        this.#path = path.split('/').filter(p => p);
        this.#path.unshift(''); // Add leading empty element to generate /C:/aaa
    }

    #parseUnixPath(path: string): void {
        this.#scheme = 'file';
        this.#path = path.split('/');
    }

    #parseAuthority(authority: string): void {
        // Extract userinfo
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

        // Extract host and port
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

        // Extract port
        if (authority.startsWith(':')) {
            const portStr = authority.slice(1);
            if (portStr && /^\d+$/.test(portStr)) {
                const port = parseInt(portStr, 10);
                if (port > 65535) {
                    throw new TypeError('Invalid URL: invalid port');
                }
                // Only set when non-default port
                const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                if (defaultPort !== port) {
                    this.#port = String(port);
                }
            } else if (portStr) {
                throw new TypeError('Invalid URL: invalid port');
            }
        }
    }

    #parsePath(path: string, isSpecial: boolean): void {
        if (path.startsWith('/')) {
            this.#path = [];
            path = path.slice(1);
        }

        if (!path) return;

        const trailingSlash = path.endsWith('/');
        const segments = path.split('/');
        for (const segment of segments) {
            if (segment === '' || segment === '.') {
                continue;
            }
            if (segment === '..') {
                if (isSpecial) {
                    if (this.#path.length > 0 && this.#path[this.#path.length - 1] !== '..') {
                        this.#path.pop();
                    }
                } else {
                    this.#path.push('..');
                }
            } else {
                this.#path.push(segment);
            }
        }

        // Preserve trailing slash: /vip/ → ['vip', ''] → pathname '/vip/'
        if (trailingSlash) {
            this.#path.push('');
        }
    }

    // ==================== Getters ====================

    get href(): string {
        return this.toString();
    }

    set href(value: string) {
        this.#scheme = ''; this.#host = ''; this.#port = '';
        this.#username = ''; this.#password = '';
        this.#path = []; this.#query = null; this.#hasQuery = false; this.#fragment = '';
        this.#parse(value);
    }

    get origin(): string {
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
        let hostPart: string;
        let portStr = '';

        if (str.startsWith('[')) {
            const endBracket = str.indexOf(']');
            if (endBracket === -1) {
                this.#host = str.toLowerCase();
                this.#port = '';
                return;
            }
            hostPart = str.slice(0, endBracket + 1).toLowerCase();
            if (str[endBracket + 1] === ':') portStr = str.slice(endBracket + 2);
        } else {
            const colonIndex = str.lastIndexOf(':');
            if (colonIndex === -1) {
                hostPart = str.toLowerCase();
            } else {
                hostPart = str.slice(0, colonIndex).toLowerCase();
                portStr = str.slice(colonIndex + 1);
            }
        }

        this.#host = hostPart;
        if (portStr && /^\d+$/.test(portStr)) {
            const port = parseInt(portStr, 10);
            if (port <= 65535) {
                const defaultPort = SPECIAL_SCHEMES[this.#scheme];
                this.#port = defaultPort === port ? '' : String(port);
            }
        } else {
            this.#port = '';
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
            if (this.#path.length === 0) return '/';
            return '/' + this.#path.join('/');
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
            this.#hasQuery = false;
            this.#searchParams._replaceFromQuery('');
            return;
        }

        this.#query = str.startsWith('?') ? str.slice(1) : str;
        this.#hasQuery = true;
        this.#searchParams._replaceFromQuery(this.#query);
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

    // ==================== Methods ====================

    toString(): string {
        let result = this.#scheme + ':';

        if (this.#host || this.#scheme === 'file' || (this.#scheme in SPECIAL_SCHEMES)) {
            result += '//';
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

        if (this.#hasQuery) result += '?' + (this.#query ?? '');

        if (this.#fragment) {
            result += '#' + this.#fragment;
        }

        return result;
    }

    toJSON(): string {
        return this.toString();
    }

    get [Symbol.toStringTag]() {
        return 'URL';
    }
}