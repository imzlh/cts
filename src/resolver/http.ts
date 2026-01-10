// resolvers/http.ts - HTTP Module Resolver

import type { RuntimeConfig } from '../types.ts';
import {
    errMsg,
    joinPaths,
    dirname,
    hashString,
    ensureDir,
    normalizePath,
    getBasenameFromUrl,
    fetchSync,
    fetchBinary
} from '../utils';
import { URL } from '../http/url';
import { BaseResolver } from './base';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const console = import.meta.use('console');

/**
 * HTTP Module Resolver
 */
export class HttpResolver extends BaseResolver {
    /** URL mapping for relative resolution */
    private readonly urlMap = new Map<string, string>();

    constructor(private readonly config: RuntimeConfig) { 
        super();
    }

    readonly protocol = ['http', 'https'];

    /**
     * Resolve HTTP(S) module
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): string {
        console.debug('HttpResolver resolve - specifier:', specifier);
        console.debug('HttpResolver resolve - parent:', parent);
        
        try {
            // If relative path, resolve based on parent URL
            if (specifier.startsWith('./') || specifier.startsWith('../')) {
                if (!parent) {
                    throw new Error(`Relative import requires parent: ${specifier}`);
                }
                const resolved = this.resolveRelative(specifier, parent);
                console.debug('HttpResolver resolve - resolved relative path:', resolved);
                return resolved;
            }
            
            // If absolute path, resolve based on parent URL
            if (specifier.startsWith('/')) {
                if (!parent) {
                    throw new Error(`Absolute import requires parent: ${specifier}`);
                }
                const resolved = this.resolveAbsolute(specifier, parent);
                console.debug('HttpResolver resolve - resolved absolute path:', resolved);
                return resolved;
            }
            
            // Directly handle full URL
            const url = specifier;
            console.debug('HttpResolver resolve - direct URL:', url);
            
            // Verify URL format before passing to fetchBinary
            const urlObj = new URL(url);
            console.debug('HttpResolver resolve - URL object after parsing:', urlObj.toString());
            console.debug('HttpResolver resolve - URL protocol:', urlObj.protocol);
            console.debug('HttpResolver resolve - URL host:', urlObj.host);
            console.debug('HttpResolver resolve - URL href:', urlObj.href);
            
            // Check cache
            const cachedPath = this.getCachePath(url);
            if (fs.exists(cachedPath)) {
                this.urlMap.set(cachedPath, url);
                console.debug('HttpResolver resolve - found in cache:', url);
                return url;
            }

            // Log download
            this.logDownload(`Downloading ${url}`);

            // Get content with progress bar
            const content = fetchBinary(url, 5, !this.config.silent);

            // Save to cache
            ensureDir(dirname(cachedPath));
            fs.writeFile(cachedPath, content);

            // Track URL mapping
            this.urlMap.set(cachedPath, url);

            return url;
        } catch (error) {
            // For HTTP errors, provide more detailed error message
            if (error instanceof Error && error.message.includes('HTTP error:')) {
                throw new Error(`HTTP error: ${error.message.split('HTTP error:')[1]}`);
            }
            console.debug('error:', error);
            throw new Error(`Failed to resolve HTTP module ${specifier}: ${errMsg(error)}`);
        }
    }
    
    /**
     * Resolve relative import
     */
    private resolveRelative(relativePath: string, parentUrl: string): string {
        console.debug('HttpResolver resolveRelative - relativePath:', relativePath);
        console.debug('HttpResolver resolveRelative - parentUrl:', parentUrl);
        
        // Use URL class to handle relative path resolution
        const baseUrl = new URL(parentUrl);
        const resolvedUrl = new URL(relativePath, baseUrl);
        console.debug('HttpResolver resolveRelative - resolved URL:', resolvedUrl.toString());
        
        return this.resolve(resolvedUrl.toString());
    }
    
    /**
     * Resolve absolute path
     */
    private resolveAbsolute(absolutePath: string, parentUrl: string): string {
        const url = new URL(parentUrl);
        
        // Create a new URL by combining the parent URL's protocol and host with the absolute path
        // This avoids the file protocol issue when using the URL constructor with absolute paths
        const protocol = url.protocol;
        const host = url.host;
        const port = url.port;
        
        // Construct the URL manually to preserve the parent's protocol and host
        const newUrlString = `${protocol}//${host}${port ? ':' + port : ''}${absolutePath}`;
        
        return this.resolve(newUrlString);
    }

    /**
     * Get local path
     */
    getLocalPath(url: string): string {
        if (this.urlMap.has(url))
            return this.urlMap.get(url)!;
        return this.getCachePath(url);
    }

    /**
     * Check if path is a cached HTTP module
     */
    isCachedModule(path: string): boolean {
        return this.urlMap.has(path);
    }

    /**
     * Get cache path for HTTP module
     */
    private getCachePath(url: string): string {
        const parsed = new URL(url);
        const hash = hashString(url);
        const ext = getBasenameFromUrl(url);

        // Create path: cacheDir/http/host/hash.ext
        return joinPaths(this.config.cacheDir, 'http', parsed.hostname, `${hash}/${ext}`);
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