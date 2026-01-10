// resolvers/data.ts - Data Protocol Resolver

import type { RuntimeConfig } from '../types.ts';
import {
    errMsg,
    hashString,
    ensureDir,
    joinPaths,
    dirname
} from '../utils';
import { BaseResolver } from './base.js';
import { FileType } from '../types';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const sys = import.meta.use('sys');
const console = import.meta.use('console');
const crypto = import.meta.use('crypto');

/**
 * Data Protocol Resolver
 * Handles data: URLs and converts them to local file paths
 */
export class DataResolver extends BaseResolver {
    constructor(private readonly config: RuntimeConfig) { 
        super();
    }

    readonly protocol = ['data'];

    /**
     * Resolve data: URL to local path
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): string {
        try {
            if (!specifier.startsWith('data:')) {
                throw new Error(`Invalid data URL: ${specifier}`);
            }
            
            // Parse data URL
            const parsed = this.parseDataUrl(specifier);
            
            // Create cache file path
            const hash = hashString(specifier);
            const extension = this.getExtensionFromMimeType(parsed.mimeType);
            const cachePath = joinPaths(this.config.cacheDir, 'data', `${hash}${extension}`);
            
            // Check if already cached
            if (fs.exists(cachePath)) {
                return specifier;
            }
            
            // Ensure cache directory exists
            ensureDir(dirname(cachePath));
            
            // Write data to cache
            if (parsed.isBase64) {
                // Decode base64 data using crypto module
                try {
                    const decodedData = crypto.base64Decode(parsed.data);
                    fs.writeFile(cachePath, decodedData);
                } catch (e) {
                    throw new Error(`Failed to decode base64 data: ${errMsg(e)}`);
                }
            } else {
                // Write URL-encoded data as text
                const textContent = decodeURIComponent(parsed.data);
                fs.writeFile(cachePath, engine.encodeString(textContent));
            }
            
            return specifier;
        } catch (error) {
            throw new Error(`Failed to resolve data module ${specifier}: ${errMsg(error)}`);
        }
    }

    /**
     * Get local path for data: URL
     */
    getLocalPath(url: string): string {
        if (!url.startsWith('data:')) {
            return url;
        }
        
        // Create cache file path
        const hash = hashString(url);
        const parsed = this.parseDataUrl(url);
        const extension = this.getExtensionFromMimeType(parsed.mimeType);
        return joinPaths(this.config.cacheDir, 'data', `${hash}${extension}`);
    }
    
    /**
     * Get file type for data: URL
     */
    getFileType(path: string): FileType {
        if (!path.startsWith('data:')) {
            return FileType.TEXT;
        }
        
        const parsed = this.parseDataUrl(path);
        
        // Check MIME type
        if (parsed.mimeType.startsWith('image/') || 
            parsed.mimeType.startsWith('video/') || 
            parsed.mimeType.startsWith('audio/') ||
            parsed.mimeType === 'application/octet-stream' ||
            parsed.mimeType.endsWith('/wasm')) {
            return FileType.BINARY;
        }
        
        return FileType.TEXT;
    }
    
    /**
     * Parse data: URL
     */
    private parseDataUrl(url: string): {
        mimeType: string;
        isBase64: boolean;
        data: string;
    } {
        // Remove data: prefix
        const urlWithoutPrefix = url.substring(5);
        
        // Split at comma
        const commaIndex = urlWithoutPrefix.indexOf(',');
        if (commaIndex === -1) {
            throw new Error(`Invalid data URL format: ${url}`);
        }
        
        const metaInfo = urlWithoutPrefix.substring(0, commaIndex);
        const data = urlWithoutPrefix.substring(commaIndex + 1);
        
        // Default MIME type
        let mimeType = 'text/plain;charset=US-ASCII';
        let isBase64 = false;
        
        if (metaInfo) {
            // Check for base64
            if (metaInfo.endsWith(';base64')) {
                isBase64 = true;
                mimeType = metaInfo.substring(0, metaInfo.length - 7);
            } else {
                mimeType = metaInfo;
            }
            
            // Default charset if not specified
            if (mimeType.startsWith('text/') && !mimeType.includes('charset=')) {
                mimeType += ';charset=US-ASCII';
            }
        }
        
        return { mimeType, isBase64, data };
    }
    
    /**
     * Get file extension from MIME type
     */
    private getExtensionFromMimeType(mimeType: string): string {
        // Extract MIME type without charset
        const mimeOnly = mimeType.split(';')[0]!;
        
        // Map common MIME types to extensions
        const mimeToExt: Record<string, string> = {
            'text/plain': '.txt',
            'text/html': '.html',
            'text/css': '.css',
            'text/javascript': '.js',
            'application/javascript': '.js',
            'application/json': '.json',
            'application/xml': '.xml',
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/svg+xml': '.svg',
            'application/wasm': '.wasm',
            'application/typescript': '.ts',
            'application/typescript; charset=utf-8': '.ts',
            'application/octet-stream': '.bin'
        };
        
        return mimeToExt[mimeOnly] || '.txt';
    }
}