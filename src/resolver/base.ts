// resolver/base.ts - Protocol Resolver Base Class

import { FileType } from '../types';

/**
 * Module type enum
 */
export enum ModuleType {
    ESM = 0,    // ES Module
    CJS = 1,    // CommonJS
    UNKNOWN = 2
}

/**
 * Result of module resolution
 */
export interface ResolveResult {
    /** Local file path */
    path: string;
    /** Whether this module should be treated as CommonJS */
    isCjs?: boolean;
}

/**
 * Result of getLocalPath with module type information
 */
export interface LocalPathResult {
    /** Local file path */
    path: string;
    /** Module type */
    moduleType?: ModuleType;
}

/**
 * Base class for protocol resolvers
 * Responsibility: Convert protocol URLs to local file paths
 */
export abstract class BaseResolver {
    protected $textExtension = ['.js', '.json', '.jsx', '.ts', '.tsx', '.jsonc'];

    /** Supported protocols */
    abstract readonly protocol: string[];

    /**
     * Resolve module and return local path with metadata
     * @param specifier Module identifier
     * @param parent Parent module path (optional)
     * @param attr Import attributes (optional)
     * @returns ResolveResult with path and optional isCjs flag
     */
    abstract resolve(specifier: string, parent?: string, attr?: Record<string, any>): ResolveResult;

    /**
     * Get local path with module type information
     * @param url Module URL or identifier
     * @returns LocalPathResult with path and optional module type
     */
    abstract getLocalPath(url: string): LocalPathResult;

    /**
     * Get file type
     * @param path File path
     * @returns File type
     */
    getFileType(path: string): FileType {
        if (this.$textExtension.some(ext => path.endsWith(ext))) {
            return FileType.TEXT;
        }
        return FileType.BINARY;
    }
}
