// resolvers/http.ts - HTTP Module Resolver

import type { RuntimeConfig } from '../types.ts';
import {
    errMsg,
    joinPaths,
    dirname,
    hashString,
    getExtensionFromUrl,
    ensureDir,
    SimpleUrl,
    normalizePath
} from '../utils';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const xhr = import.meta.use('xhr');
const console = import.meta.use('console');

/**
 * HTTP Module Resolver
 */
export class HttpResolver {
    /** URL mapping for relative resolution */
    private readonly urlMap = new Map<string, string>();

    constructor(private readonly config: RuntimeConfig) { }

    /**
     * Resolve HTTP(S) module
     */
    resolve(url: string): string {
        try {
            // Check cache first
            const cachedPath = this.getCachePath(url);
            if (fs.exists(cachedPath)) {
                this.urlMap.set(cachedPath, url);
                return cachedPath;
            }

            // Log download
            this.logDownload(`Downloading ${url}`);

            // Fetch content
            const content = this.fetchSync(url);

            // Save to cache
            ensureDir(dirname(cachedPath));
            const encoded = engine.encodeString(content);
            fs.writeFile(cachedPath, encoded.buffer);

            // Track URL mapping
            this.urlMap.set(cachedPath, url);

            return url;
        } catch (error) {
            throw new Error(`Failed to resolve HTTP module ${url}: ${errMsg(error)}`);
        }
    }

    /**
     * Resolve relative import from HTTP URL
     */
    resolveRelative(relativePath: string, parentUrl: string): string {
        const url = new SimpleUrl(parentUrl);
        const parentDir = url.pathname.substring(0, url.pathname.lastIndexOf('/'));

        // Resolve relative path
        const resolvedPath = normalizePath(joinPaths(parentDir, relativePath));

        // Construct new URL
        const newUrl = `${url.protocol}://${url.host}${resolvedPath}`;

        return this.resolve(newUrl);
    }

    /**
     * 获取 HTTP URL 对应的本地文件路径
     * 
     * @param url HTTP(S) URL
     * @returns 本地文件路径
     */
    getLocalPath(url: string): string {
        if (this.urlMap.has(url))
            return url;
        return this.getCachePath(url);
    }

    /**
     * Get original URL for a cached path
     */
    getOriginalUrl(cachedPath: string): string | undefined {
        return this.urlMap.get(cachedPath);
    }

    /**
     * Check if path is a cached HTTP module
     */
    isCachedModule(path: string): boolean {
        return this.urlMap.has(path);
    }

    /**
     * Fetch URL synchronously
     */
    private fetchSync(url: string): string {
        try {
            const request = new xhr.XMLHttpRequest();
            request.open('GET', url, false); // false = synchronous
            request.send();

            if (request.status !== 200) {
                throw new Error(`HTTP ${request.status}: ${request.statusText}`);
            }

            return request.responseText;
        } catch (error) {
            throw new Error(`Failed to fetch ${url}: ${errMsg(error)}`);
        }
    }

    /**
     * Get cache path for HTTP module
     */
    private getCachePath(url: string): string {
        const parsed = new SimpleUrl(url);
        const hash = hashString(url);
        const ext = getExtensionFromUrl(url);

        // Create path: cacheDir/http/host/hash.ext
        return joinPaths(this.config.cacheDir, 'http', parsed.host, `${hash}${ext}`);
    }

    /**
     * Log download activity
     */
    private logDownload(message: string): void {
        if (!this.config.silent) {
            console.log(`📦 ${message}`);
        }
    }
}