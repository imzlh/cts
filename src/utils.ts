// utils.ts - Utility Functions

const fs = import.meta.use('fs');
const sys = import.meta.use('sys');
const engine = import.meta.use('engine');
const console = import.meta.use('console');
const os = import.meta.use('os');

import { URL } from "./http/url";
import { type ConnectionConfig, connectionManager } from "./http/connection";
import { HttpRequestBuilder, HttpResponseParser } from "./http/http";
import { HttpProgressBar } from "./http/process";

// Local assertion function
export function assert(condition: any, message?: string): asserts condition {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

/**
 * Get error message safely
 */
export function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    return String(e);
}

type Template = Record<string, 'string' | 'boolean' | 'number'>;
export function parseArgs<T extends Template>(
    argv: string[],
    tpl: T
): {
    [K in keyof T]?: T[K] extends 'string' ? string : T[K] extends 'number' ? number : boolean;
} & { _?: string, _args?: string[], _offset: number } {
    const out: any = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith('--')) {
            // entry
            out._ = arg;
            out._args = argv.slice(i + 1);
            out._offset = i + 1;
            break;
        }

        const key = arg.slice(2);
        const type = tpl[key];
        if (!type) {
            throw new Error(`Invalid argument: ${key}`);
        }
        const next = argv[i + 1];

        switch (type) {
            case 'boolean':
                out[key] = true;
                break;
            case 'string':
                if (next && !next.startsWith('--')) {
                    out[key] = next;
                    i++;
                }
                break;
            case 'number':
                if (next && !next.startsWith('--')) {
                    const n = Number(next);
                    if (!Number.isNaN(n)) out[key] = n;
                    i++;
                }
                break;
        }
    }
    return out;
}

/**
 * Read a text file synchronously
 */
export function readTextFile(path: string): string {
    const buffer = fs.readFile(path);
    return engine.decodeString(buffer);
}

/**
 * Write a text file synchronously
 */
export function writeTextFile(path: string, content: string): void {
    const encoded = engine.encodeString(content);
    fs.writeFile(path, encoded.buffer);
}

/** 
 * Resolve a path relative to the current working directory
 */
export function resolvePath(...parts: string[]): string {
    let resolved = joinPaths(...parts);
    if (!resolved.startsWith('/')) {
        resolved = joinPaths(os.cwd, resolved);
    }

    // Normalize path
    const segments: string[] = [];
    for (const segment of resolved.split('/')) {
        if (segment === '..') {
            segments.pop();
        } else if (segment !== '.' && segment !== '') {
            segments.push(segment);
        }
    }

    return '/' + segments.join('/');
}

export function extname(p: string): string {
    const base = basename(p);
    const idx = base.lastIndexOf('.');
    return idx === -1 ? '' : base.substring(idx);
}

/**
 * Join path segments
 */
export function joinPaths(...segments: string[]): string {
    return segments
        .filter(Boolean)
        .join('/')
        .replace(/\/+/g, '/');
}

/**
 * Get directory name from path
 */
export function dirname(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash > 0 ? normalized.substring(0, lastSlash) : '.';
}

/**
 * Get file extension
 */
export function getExtension(path: string): string {
    const lastDot = path.lastIndexOf('.');
    return lastDot > 0 ? path.substring(lastDot) : '';
}

/**
 * Normalize path (resolve . and ..)
 */
export function normalizePath(path: string): string {
    const parts = path.split('/').filter(p => p && p !== '.');
    const result: string[] = [];

    for (const part of parts) {
        if (part === '..') {
            if (result.length > 0 && result.at(-1) !== '..') {
                result.pop();
            } else if (!path.startsWith('/')) {
                result.push('..');
            }
        } else {
            result.push(part);
        }
    }

    let normalized = result.join('/');
    if (path.startsWith('/') && !normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }

    return normalized || '.';
}

/**
 * Ensure directory exists (create if not)
 */
export function ensureDir(dir: string): void {
    if (fs.exists(dir)) return;

    const parent = dirname(dir);
    if (parent && parent !== dir && parent !== '.') {
        ensureDir(parent);
    }

    try {
        fs.mkdir(dir, 0o755);
    } catch (error) {
        if (!fs.exists(dir)) throw error;
    }
}

/**
 * FNV-1a 64-bit hash function for better collision resistance
 * Returns a hexadecimal string of the hash
 */
export function hashString(str: string): string {
    // FNV-1a 64-bit constants
    const FNV_64_PRIME = 1099511628211n;
    const FNV_64_OFFSET_BASIS = 14695981039346656037n;

    let hash = FNV_64_OFFSET_BASIS;

    for (let i = 0; i < str.length; i++) {
        hash ^= BigInt(str.charCodeAt(i));
        hash *= FNV_64_PRIME;
    }

    // Convert to hex string, ensuring positive value
    return (hash & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
}

/**
 * Create a cache-safe filename from URL
 * Combines hostname, path hash, and original filename for debugging
 */
export function createCacheFilename(url: string): string {
    try {
        const urlObj = new URL(url);
        const hash = hashString(url);

        // Extract original filename for debugging
        const pathname = urlObj.pathname;
        const lastSlash = pathname.lastIndexOf('/');
        const originalName = lastSlash >= 0 ? pathname.substring(lastSlash + 1) : pathname;

        // Clean up original name (remove query strings, keep extension)
        const cleanName = originalName.split('?')[0]!.split('#')[0]!;
        const extMatch = cleanName.match(/\.[a-zA-Z0-9]+$/);
        const ext = extMatch ? extMatch[0] : '';

        // Format: hash.ext (for uniqueness) or hash_original.ext (for debug)
        return ext ? `${hash}${ext}` : hash;
    } catch {
        // Invalid URL, fallback to simple hash
        return hashString(url);
    }
}

/**
 * Get file basename from URL
 */
export function getBasenameFromUrl(url: string): string {
    const path = url.split('?')[0]!.split('#')[0]!;
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash > 0) {
        return path.substring(lastSlash);
    }

    return 'index.js'; // Default extension
}

/**
 * Get basename from path
 */
export function basename(p: string, ext?: string): string {
    // Normalize path separators to forward slashes
    const normalized = p.replace(/\\/g, '/');
    // Remove trailing slash
    const trimmed = normalized.replace(/\/$/, '');
    const lastSlashIndex = trimmed.lastIndexOf('/');
    let result = lastSlashIndex === -1 ? trimmed : trimmed.substring(lastSlashIndex + 1);

    if (ext && result.endsWith(ext)) {
        result = result.substring(0, result.length - ext.length);
    }

    return result;
}

/**
 * Check if path is absolute
 */
export function isAbsolutePath(path: string): boolean {
    if (path.startsWith('/')) return true;
    // Windows: C:\ or C:/
    if (sys.platform === 'win32' && /^[a-zA-Z]:[/\\]/.test(path)) return true;
    return false;
}

/**
 * Parse version string and resolve incomplete versions
 * Handles cases like "1" -> "1.x.x", "1.0" -> "1.0.x"
 * Returns the most specific version available from the versions list
 */
export function resolveVersion(version: string, availableVersions: string[]): string {
    // If version is already complete (has at least 3 parts), return as is
    if (version.split('.').length >= 3) {
        return version;
    }

    // If version is a range specifier (^, ~, >=, <=, >), return as is for special handling
    if (/^[\^~><=]/.test(version)) {
        return version;
    }

    // Split version into parts
    const versionParts = version.split('.').map(Number);

    // Filter and sort available versions that match the pattern
    const matchingVersions = availableVersions
        .filter(v => {
            const vParts = v.split('.').map(Number);

            // Check if this version matches the pattern
            for (let i = 0; i < versionParts.length; i++) {
                if (vParts[i] !== versionParts[i]) {
                    return false;
                }
            }
            return true;
        })
        .sort((a, b) => {
            // Sort versions in descending order (highest first)
            const aParts = a.split('.').map(Number);
            const bParts = b.split('.').map(Number);

            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                const aPart = aParts[i] || 0;
                const bPart = bParts[i] || 0;
                if (aPart !== bPart) {
                    return bPart - aPart; // Descending order
                }
            }
            return 0;
        });

    // Return the highest matching version, or the original version if no match found
    return matchingVersions.length > 0 ? matchingVersions[0]! : version;
}

/**
 * Check if cache is expired
 */
export function isCacheExpired(timestamp: number, ttl: number): boolean {
    return Date.now() - timestamp > ttl;
}

/**
 * Simple URL parser
 */
export class SimpleUrl {
    protocol: string;
    host: string;
    pathname: string;
    search: string;
    hash: string;

    constructor(url: string) {
        const protocolMatch = url.match(/^([a-z]+):\/\//);
        if (!protocolMatch) {
            throw new Error(`Invalid URL: ${url}`);
        }

        this.protocol = protocolMatch[1]!;
        let rest = url.substring(protocolMatch[0]!.length);

        // Extract hash
        const hashIndex = rest.indexOf('#');
        if (hashIndex !== -1) {
            this.hash = rest.substring(hashIndex);
            rest = rest.substring(0, hashIndex);
        } else {
            this.hash = '';
        }

        // Extract search
        const searchIndex = rest.indexOf('?');
        if (searchIndex !== -1) {
            this.search = rest.substring(searchIndex);
            rest = rest.substring(0, searchIndex);
        } else {
            this.search = '';
        }

        // Extract host and pathname
        const pathIndex = rest.indexOf('/');
        if (pathIndex !== -1) {
            this.host = rest.substring(0, pathIndex);
            this.pathname = rest.substring(pathIndex);
        } else {
            this.host = rest;
            this.pathname = '/';
        }
    }
}

/**
 * Try to resolve file with extensions
 */
export function tryResolveFile(basePath: string, extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.wasm']): string {
    // Try exact path first
    if (fs.exists(basePath)) {
        const stats = fs.stat(basePath);
        if (stats.isFile) {
            return basePath;
        }
        // If directory, try index files
        if (stats.isDirectory) {
            return tryResolveFile(joinPaths(basePath, 'index'), extensions);
        }
    }

    // Try with extensions
    for (const ext of extensions) {
        const pathWithExt = basePath + ext;
        if (fs.exists(pathWithExt)) {
            return pathWithExt;
        }
    }

    // Try index files in directory
    const indexPaths = [
        joinPaths(basePath, 'index.ts'),
        joinPaths(basePath, 'index.tsx'),
        joinPaths(basePath, 'index.js'),
        joinPaths(basePath, 'index.jsx'),
    ];

    for (const indexPath of indexPaths) {
        if (fs.exists(indexPath)) {
            return indexPath;
        }
    }

    throw new Error(`Cannot find module: ${basePath}`);
}

/**
 * Version number completion: "1" → "1.0.0", "1.2" → "1.2.0"
 */
function expandVersion(version: string): string {
    const parts = version.split('.').map(p => parseInt(p, 10));
    while (parts.length < 3) parts.push(0);
    return parts.join('.');
}

function compareSemVer(v1: string, v2: string): number {
    const [v1Core, v1Pre] = v1.split('-');
    const [v2Core, v2Pre] = v2.split('-');

    const v1Parts = v1Core!.split('.').map(Number);
    const v2Parts = v2Core!.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        const part1 = v1Parts[i] || 0;
        const part2 = v2Parts[i] || 0;
        if (part1 !== part2) return part1 - part2;
    }

    if (!v1Pre && !v2Pre) return 0;
    if (!v1Pre && v2Pre) return 1;
    if (v1Pre && !v2Pre) return -1;

    return v1Pre!.localeCompare(v2Pre!);
}

/**
 * Version comparison: returns -1, 0, 1
 */
function compareVersions(v1: string, v2: string): number {
    const p1 = v1.split('.').map(Number);
    const p2 = v2.split('.').map(Number);

    // Pad to 3 parts
    while (p1.length < 3) p1.push(0);
    while (p2.length < 3) p2.push(0);

    for (let i = 0; i < 3; i++) {
        if (p1[i] !== p2[i]) return p1[i]! - p2[i]!;
    }
    return compareSemVer(v1, v2);
}

/**
 * Check if version satisfies range
 * @param version Version number (e.g. "1.2.3")
 * @param range Version range (e.g. "^1.2.3", "~1.2.3", "1.2.x", "1.2.*")
 * @returns Whether version satisfies the range
 */
function satisfiesVersion(version: string, range: string): boolean {
    if (!version || !range) return false;

    // Complete version numbers
    const fullVersion = expandVersion(version.trim());
    let rangeStr = range.trim();

    // Auto-complete shorthand versions: "1.2" → "1.2.x"
    if (/^\d+(\.\d+)?$/.test(rangeStr)) {
        rangeStr = `${rangeStr}.x`;
    }

    // Exact version match
    if (/^\d+\.\d+\.\d+$/.test(rangeStr)) {
        return compareVersions(fullVersion, rangeStr) === 0;
    }

    // ^ caret: ^1.2.3
    if (rangeStr.startsWith('^')) {
        const base = expandVersion(rangeStr.slice(1));
        const [major, minor, patch] = base.split('.').map(Number);

        // Major version 0: lock minor version
        if (major === 0) {
            return compareVersions(fullVersion, base) >= 0 &&
                compareVersions(fullVersion, `0.${minor! + 1}.0`) < 0;
        }

        // Major version non-zero: lock major version
        return compareVersions(fullVersion, base) >= 0 &&
            compareVersions(fullVersion, `${major! + 1}.0.0`) < 0;
    }

    // ~ tilde: ~1.2.3
    if (rangeStr.startsWith('~')) {
        const base = expandVersion(rangeStr.slice(1));
        const [major, minor] = base.split('.').map(Number);

        return compareVersions(fullVersion, base) >= 0 &&
            compareVersions(fullVersion, `${major}.${minor! + 1}.0`) < 0;
    }

    // x/X/* wildcards
    if (/x|\*/i.test(rangeStr)) {
        const pattern = rangeStr.toLowerCase().split('.');
        const verParts = fullVersion.split('.').map(Number);

        for (let i = 0; i < pattern.length && i < 3; i++) {
            if (pattern[i] === 'x' || pattern[i] === '*') continue;
            if (String(verParts[i]) !== pattern[i]) return false;
        }
        return true;
    }

    // Range: 1.2.3 - 2.0.0
    if (rangeStr.includes(' - ')) {
        const [min, max] = rangeStr.split(' - ').map(s => expandVersion(s.trim()));
        return compareVersions(fullVersion, min!) >= 0 && compareVersions(fullVersion, max!) <= 0;
    }

    // Comparison operators: >=1.0.0, <2.0.0
    const match = rangeStr.match(/^(>=?|<=?|=)\s*(.+)$/);
    if (match) {
        const [, op, target] = match;
        const fullTarget = expandVersion(target!);
        const cmp = compareVersions(fullVersion, fullTarget);
        switch (op) {
            case '>=': return cmp >= 0;
            case '>': return cmp > 0;
            case '<=': return cmp <= 0;
            case '<': return cmp < 0;
            case '=': return cmp === 0;
        }
    }

    return false;
}

/**
 * 在版本数组中筛选符合指定版本范围的版本
 * @param versions 版本数组
 * @param range 版本范围
 * @returns 符合范围的版本数组
 */
export function matchVersion(versions: string[], range: string): string[] {
    return versions.filter(version => satisfiesVersion(version, range));
}

/**
 * 在版本数组中筛选符合指定版本范围的版本，并返回最新版本
 * @param versions 版本数组
 * @param range 版本范围
 * @returns 符合范围的最新版本，如果没有则返回null
 */
export function matchLatestVersion(versions: string[], range: string): string | null {
    const matched = matchVersion(versions, range);
    if (matched.length === 0) return null;

    return matched.reduce((latest, current) => compareVersions(current, latest) > 0 ? current : latest);
}

// targz.ts - Tar.gz Extraction Utility

const zlib = import.meta.use('zlib');

/**
 * Tar 文件条目
 */
export interface TarFile {
    /** 文件路径 */
    path: string;
    /** 文件内容（仅对普通文件有效） */
    content: Uint8Array;
    /** 文件大小（字节） */
    size: number;
    /** 文件类型 */
    type: 'file' | 'dir' | 'link' | 'other';
}

/**
 * 解压 tar.gz 格式文件
 * 
 * @param data - tar.gz 格式的压缩数据
 * @returns 解压后的文件列表
 * @throws 如果 gzip 解压失败或 tar 格式无效会抛出错误
 */
export function unTarGz(data: ArrayBuffer | Uint8Array): TarFile[] {
    const decompressed = zlib.gunzip(data);
    const bytes = new Uint8Array(decompressed);

    const readString = (offset: number, length: number): string => {
        let result = '';
        for (let i = 0; i < length; i++) {
            const char = bytes[offset + i];
            if (!char) break;
            result += String.fromCharCode(char);
        }
        return result;
    };

    const readOctal = (offset: number, length: number): number => {
        const str = readString(offset, length).trim();
        return str ? parseInt(str, 8) : 0;
    };

    const isZeroBlock = (offset: number): boolean => {
        for (let i = 0; i < 512; i++) {
            if (bytes[offset + i] !== 0) return false;
        }
        return true;
    };

    const files: TarFile[] = [];
    const BLOCK_SIZE = 512;
    let pos = 0;

    while (pos < bytes.length) {
        // 检查结束标记（两个连续全零块）
        if (isZeroBlock(pos) && (pos + BLOCK_SIZE >= bytes.length || isZeroBlock(pos + BLOCK_SIZE))) {
            break;
        }

        // 解析头部
        const name = readString(pos, 100);
        const size = readOctal(pos + 124, 12);
        const typeFlag = readString(pos + 156, 1);

        // 跳过无效条目
        if (!name || size < 0) {
            pos += BLOCK_SIZE;
            continue;
        }

        // 计算数据位置
        const dataStart = pos + BLOCK_SIZE;
        const dataBlocks = Math.ceil(size / BLOCK_SIZE);
        const nextPos = dataStart + dataBlocks * BLOCK_SIZE;

        // 提取内容
        const content = bytes.slice(dataStart, dataStart + size);

        // 映射文件类型
        const typeMap: Record<string, TarFile['type']> = {
            '0': 'file', '\0': 'file',
            '5': 'dir',
            '2': 'link'
        };

        files.push({
            path: name,
            content,
            size,
            type: typeMap[typeFlag] || 'other'
        });

        pos = nextPos;
    }

    return files;
}

export function fetchBinary(url: string, maxRedirects: number = 5, showProgress: boolean = false): Uint8Array<ArrayBuffer> {
    let currentUrl = url;
    let redirectCount = 0;

    // Progress bar initialization
    let progressBar: any = null;
    const PROGRESS_THRESHOLD = 32 * 1024; // 32KB threshold for showing progress bar

    while (redirectCount <= maxRedirects) {
        // 解析URL
        const urlObj = new URL(currentUrl);
        const protocol = urlObj.protocol;
        const hostname = urlObj.hostname;
        const port = urlObj.port ? parseInt(urlObj.port, 10) : (protocol === "https:" ? 443 : 80);

        // 获取连接
        const cfg: ConnectionConfig = {
            hostname: hostname,
            port: port,
            // @ts-ignore
            protocol
        };
        const conn = connectionManager.acquire(cfg);

        try {
            // 使用HttpRequestBuilder构建请求
            const requestBuilder = new HttpRequestBuilder(urlObj, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; CTS/2.0)',
                    'Accept': 'application/json, text/plain, */*',
                    'Connection': 'keep-alive'
                }
            });

            // 发送请求
            const requestData = requestBuilder.build();
            conn.write(requestData);
            console.debug('[fetch] Request sent to', currentUrl);

            // 使用HttpResponseParser解析响应
            const parser = new HttpResponseParser();
            let responseBody: Uint8Array | null = null;
            let statusCode: number | null = null;
            let headers: any = null;
            let contentLength: number | null = null;

            parser.onHeadersComplete = (code, hdrs) => {
                statusCode = code;
                headers = hdrs;

                // Get content length for progress bar
                if (headers && headers.has && headers.has('content-length')) {
                    const lengthStr = headers.get('content-length');
                    if (lengthStr) {
                        contentLength = parseInt(lengthStr, 10);
                    }
                }

                // Initialize progress bar if requested and file is large enough
                if (showProgress && contentLength && contentLength > PROGRESS_THRESHOLD) {
                    progressBar = new HttpProgressBar({
                        total: contentLength || 0,
                        width: 40,
                        showSpeed: true,
                        showTime: true,
                        updateInterval: 500
                    });
                    progressBar.start(currentUrl);
                }
            };

            parser.onData = (chunk) => {
                if (!responseBody) {
                    responseBody = chunk;
                } else {
                    // 合并数据块
                    const newBody = new Uint8Array(responseBody.length + chunk.length);
                    newBody.set(responseBody);
                    newBody.set(chunk, responseBody.length);
                    responseBody = newBody;
                }

                // Initialize progress bar if we don't have content-length but have received enough data
                if (showProgress && !progressBar && responseBody.length > PROGRESS_THRESHOLD) {
                    progressBar = new HttpProgressBar({
                        total: 0, // Unknown total size
                        width: 40,
                        showSpeed: true,
                        showTime: true,
                        updateInterval: 500
                    });
                    progressBar.start(currentUrl);
                }

                // Update progress bar
                if (progressBar) {
                    progressBar.update(responseBody.length);
                }
            };

            parser.onError = (error) => {
                throw error;
            };

            // 读取响应数据并喂给解析器
            let recv = 0;

            while (!parser.isCompleted) {
                const data = conn.read(128 * 1024, true); // 128k
                if (!data) {
                    console.debug(`[fetchBinary] No data available(EOF). stop`);
                    break;
                }
                recv += data.length;
                parser.feed(data);
            }

            if (!parser.isCompleted) {
                throw new Error('Incomplete HTTP response');
            }

            // Complete progress bar if it was created
            if (progressBar) {
                progressBar.complete();
            }

            // 释放连接
            connectionManager.release(cfg, conn);

            // Check for redirects
            assert(statusCode, "Status code is null");
            if (statusCode >= 300 && statusCode < 400) {
                let location = null;

                // Try standard Location header first
                if (headers && headers.has && headers.has('location')) {
                    location = headers.get('location');
                }

                if (location) {
                    // Handle relative redirects
                    if (location.startsWith('/')) {
                        const redirectUrl = new URL(location, currentUrl);
                        currentUrl = redirectUrl.toString();
                    } else {
                        currentUrl = location;
                    }

                    redirectCount++;
                    continue; // Continue with the next iteration
                }
            }

            // Check for successful status
            if (statusCode < 200 || statusCode >= 300) {
                throw new Error(`HTTP error: ${statusCode}`);
            }

            return responseBody || new Uint8Array(0);
        } catch (error) {
            // 发生错误时关闭连接
            conn.close();

            // Clean up progress bar on error
            if (progressBar) {
                progressBar.complete();
            }

            throw error;
        }
    }

    throw new Error(`Too many redirects (${maxRedirects})`);
}

// fetchSync: always 200, return string
export function fetchSync(url: string): string {
    try {
        const bodyBytes = fetchBinary(url);
        return engine.decodeString(bodyBytes);
    } catch (error) {
        console.debug(`[fetch] Error fetching ${url}:`, error);
        throw error;
    }
}