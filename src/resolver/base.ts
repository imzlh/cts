// resolver/base.ts - Protocol Resolver Base Class

import { FileType } from '../types';

/**
 * Base class for protocol resolvers
 * Responsibility: Convert protocol URLs to local file paths
 */
export abstract class BaseResolver {
    protected $textExtension = ['.js', '.json', '.jsx', '.ts', '.tsx', '.jsonc'];

    /** Supported protocols */
    abstract readonly protocol: string[];
    
    /**
     * Resolve module and return local path
     * @param specifier Module identifier
     * @param parent Parent module path (optional)
     * @param attr Import attributes (optional)
     * @returns Local file path
     */
    abstract resolve(specifier: string, parent?: string, attr?: Record<string, any>): string;
    
    /**
     * Get local path
     * @param url Module URL or identifier
     * @returns Local file path
     */
    abstract getLocalPath(url: string): string;
    
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