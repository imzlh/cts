// resolvers/file.ts - File Protocol Resolver

import type { RuntimeConfig } from '../types.ts';
import {
    errMsg,
    joinPaths,
    dirname,
    tryResolveFile,
    normalizePath,
    isAbsolutePath,
    readTextFile
} from '../utils';
import { BaseResolver, type ResolveResult, type LocalPathResult, ModuleType } from './base.js';
import { FileType } from '../types';

const fs = import.meta.use('fs');
const sys = import.meta.use('sys');
const console = import.meta.use('console');

/**
 * File Protocol Resolver
 * Handles file:// URLs and converts them to local file paths
 */
export class FileResolver extends BaseResolver {
    constructor(private readonly config: RuntimeConfig) { 
        super();
    }

    readonly protocol = ['file'];

    /**
     * Resolve file:// URL to local path
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): ResolveResult {
        try {
            // Extract path from file:// URL
            let filePath: string;
            
            if (specifier.startsWith('file://')) {
                // Remove file:// prefix
                filePath = specifier.substring(7);
                
                // Handle Windows paths (e.g., file:///C:/path/to/file)
                if (filePath.startsWith('/') && sys.platform === 'win32' && filePath.length > 2 && filePath[2] === ':') {
                    filePath = filePath.substring(1);
                }
            } else {
                // Not a file:// URL, this shouldn't happen with this resolver
                throw new Error(`Invalid file URL: ${specifier}`);
            }
            
            // Normalize the path
            filePath = normalizePath(filePath);
            
            // Check if file exists
            if (!fs.exists(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }
            
            // Check if it's a file (not a directory)
            try {
                const stats = fs.stat(filePath);
                if (!stats.isFile) {
                    throw new Error(`Path is not a file: ${filePath}`);
                }
            } catch (error) {
                // If we can't stat the file, it might be a permission issue
                throw new Error(`Cannot access file: ${filePath}`);
            }
            
            // Determine module type
            const moduleType = this.detectModuleType(filePath);
            
            return { path: specifier, isCjs: moduleType === ModuleType.CJS };
        } catch (error) {
            // Provide a cleaner error message for common issues
            if (error instanceof Error && error.message.includes('File not found')) {
                throw error;
            }
            if (error instanceof Error && error.message.includes('Cannot access file')) {
                throw error;
            }
            throw new Error(`Failed to resolve file module ${specifier}: ${errMsg(error)}`);
        }
    }


    /**
     * Get local path for file:// URL
     */
    getLocalPath(url: string): LocalPathResult {
        if (!url.startsWith('file://')) {
            return { path: url };
        }
        
        // Remove file:// prefix
        let filePath = url.substring(7);
        
        // Handle Windows paths
        if (filePath.startsWith('/') && sys.platform === 'win32' && filePath.length > 2 && filePath[2] === ':') {
            filePath = filePath.substring(1);
        }
        
        const normalizedPath = normalizePath(filePath);
        const moduleType = this.detectModuleType(normalizedPath);
        return { path: normalizedPath, moduleType };
    }
    
    /**
     * Get file type for file:// URL
     */
    getFileType(path: string): FileType {
        const localPathResult = this.getLocalPath(path);
        
          const localPath = localPathResult.path;
        // Check file extension
        if (localPath.endsWith('.wasm')) {
            return FileType.BINARY;
        }
        
        return FileType.TEXT;
    }
    private detectModuleType(filePath: string): ModuleType {
        const ext = filePath.substring(filePath.lastIndexOf('.'));

        // .mjs is always ESM
        if (ext === '.mjs') return ModuleType.ESM;
        // .cjs is always CJS
        if (ext === '.cjs') return ModuleType.CJS;

        // For .js files, check package.json
        if (ext === '.js') {
            let dir = dirname(filePath);
            while (dir !== '/' && dir !== '.') {
                const pkgPath = joinPaths(dir, 'package.json');
                if (fs.exists(pkgPath)) {
                    try {
                        const pkg = JSON.parse(readTextFile(pkgPath));
                        return pkg.type === 'module' ? ModuleType.ESM : ModuleType.CJS;
                    } catch {
                        return ModuleType.CJS; // Default to CJS on error
                    }
                }
                const parent = dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
            return ModuleType.CJS; // Default to CJS for .js files
        }

        // Default to ESM for other extensions
        return ModuleType.ESM;
    }
}
