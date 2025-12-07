// utils.ts - Utility Functions

const fs = import.meta.use('fs');
const sys = import.meta.use('sys');
const engine = import.meta.use('engine');

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
        if (!arg.startsWith('--')){
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
 * Simple string hash function
 */
export function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
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
 * Check if path is absolute
 */
export function isAbsolutePath(path: string): boolean {
    if (path.startsWith('/')) return true;
    // Windows: C:\ or C:/
    if (sys.platform === 'win32' && /^[a-zA-Z]:[/\\]/.test(path)) return true;
    return false;
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
export function tryResolveFile(basePath: string, extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']): string {
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
 * 比较两个版本号的大小
 * @param v1 版本号1
 * @param v2 版本号2
 * @returns -1: v1 < v2, 0: v1 = v2, 1: v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(part => {
        const num = parseInt(part, 10);
        return isNaN(num) ? 0 : num;
    });
    const parts2 = v2.split('.').map(part => {
        const num = parseInt(part, 10);
        return isNaN(num) ? 0 : num;
    });

    const maxLength = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLength; i++) {
        const part1 = parts1[i] || 0;
        const part2 = parts2[i] || 0;

        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }

    return 0;
}

/**
 * 检查版本是否满足范围条件
 * @param version 要检查的版本
 * @param range 版本范围
 * @returns 是否满足条件
 */
function satisfiesVersion(version: string, range: string): boolean {
    // 处理固定版本
    if (!range.includes('^') && !range.includes('~') && !range.includes('*') &&
        !range.includes('x') && !range.includes('>') && !range.includes('<') &&
        !range.includes('-')) {
        return compareVersions(version, range) === 0;
    }

    // 处理 ^ 插入符
    if (range.startsWith('^')) {
        const baseVersion = range.slice(1);
        const baseParts = baseVersion.split('.').map(part => parseInt(part, 10));

        // 主版本号为0时，^行为与~相同
        if (baseParts[0] === 0) {
            // 对于 0.x.y，^0.x.y 表示 >=0.x.y <0.(x+1).0
            const minVersion = baseVersion;
            const maxVersion = `0.${baseParts[1]! + 1}.0`;
            return compareVersions(version, minVersion) >= 0 && compareVersions(version, maxVersion) < 0;
        } else {
            // 对于 x.y.z，^x.y.z 表示 >=x.y.z <(x+1).0.0
            const minVersion = baseVersion;
            const maxVersion = `${baseParts[0]! + 1}.0.0`;
            return compareVersions(version, minVersion) >= 0 && compareVersions(version, maxVersion) < 0;
        }
    }

    // 处理 ~ 波浪符
    if (range.startsWith('~')) {
        const baseVersion = range.slice(1);
        const baseParts = baseVersion.split('.').map(part => parseInt(part, 10));

        // ~x.y.z 表示 >=x.y.z <x.(y+1).0
        const minVersion = baseVersion;
        const maxVersion = `${baseParts[0]}.${baseParts[1]! + 1}.0`;
        return compareVersions(version, minVersion) >= 0 && compareVersions(version, maxVersion) < 0;
    }

    // 处理 * 或 x 通配符
    if (range.includes('*') || range.includes('x') || range.includes('X')) {
        const pattern = range.replace(/\*/g, 'x').replace(/X/g, 'x');
        const patternParts = pattern.split('.');
        const versionParts = version.split('.');

        for (let i = 0; i < patternParts.length; i++) {
            const patternPart = patternParts[i];
            const versionPart = versionParts[i];

            if (patternPart === 'x') {
                // 通配符匹配任何版本部分
                continue;
            }

            if (patternPart !== versionPart) {
                return false;
            }
        }
        return true;
    }

    // 处理版本范围 1.2.3 - 2.3.4
    if (range.includes(' - ')) {
        const [minRange, maxRange] = range.split(' - ').map(r => r.trim());
        return compareVersions(version, minRange!) >= 0 && compareVersions(version, maxRange!) <= 0;
    }

    // 处理比较运算符
    if (range.startsWith('>=')) {
        const baseVersion = range.slice(2);
        return compareVersions(version, baseVersion) >= 0;
    }
    if (range.startsWith('>')) {
        const baseVersion = range.slice(1);
        return compareVersions(version, baseVersion) > 0;
    }
    if (range.startsWith('<=')) {
        const baseVersion = range.slice(2);
        return compareVersions(version, baseVersion) <= 0;
    }
    if (range.startsWith('<')) {
        const baseVersion = range.slice(1);
        return compareVersions(version, baseVersion) < 0;
    }
    if (range.startsWith('=')) {
        const baseVersion = range.slice(1);
        return compareVersions(version, baseVersion) === 0;
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

    // 找到最大的版本号
    return matched.reduce((latest, current) => {
        return compareVersions(current, latest) > 0 ? current : latest;
    });
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