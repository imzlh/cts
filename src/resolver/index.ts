// resolver.ts - Main Module Resolver

import type { RuntimeConfig, CacheEntry, NodeResolver } from '../types';
import {
    joinPaths,
    dirname,
    normalizePath,
    tryResolveFile,
    isAbsolutePath
} from '../utils';
import { HttpResolver } from './http';
import { JsrResolver } from './jsr';
import { NodeModuleResolver } from './node';
import { NpmResolver } from './npm';

const fs = import.meta.use('fs');

/**
 * Main Module Resolver
 */
export class ModuleResolver {
    private readonly httpResolver: HttpResolver;
    private readonly jsrResolver: JsrResolver;
    private readonly nodeResolver: NodeModuleResolver;
    private readonly npmResolver: NpmResolver;

    constructor(private readonly config: RuntimeConfig) {
        this.httpResolver = new HttpResolver(config);
        this.jsrResolver = new JsrResolver(config);
        this.nodeResolver = new NodeModuleResolver(config);
        this.npmResolver = new NpmResolver(config);
    }

    /**
     * Register Node.js builtin resolver
     */
    registerNodeResolver(resolver: NodeResolver): void {
        this.nodeResolver.registerResolver(resolver);
    }

    /**
     * Resolve module specifier
     * return a protocol-absolute path(expect node protocol)
     */
    resolve(name: string, parent: string): string {
        let resolved: string;

        // Apply import map if available
        const mappedName = this.applyImportMap(name);

        // Handle node: protocol
        if (mappedName.startsWith('node:')) {
            if (!this.config.enableNode) {
                throw new Error('Node.js compatibility layer is disabled');
            }
            // node prefix is removed
            resolved = this.nodeResolver.resolve(mappedName);
        }
        // Handle HTTP(S) URLs
        else if (mappedName.startsWith('http://') || mappedName.startsWith('https://')) {
            if (!this.config.enableHttp) {
                throw new Error('HTTP module loading is disabled');
            }
            resolved = this.httpResolver.resolve(mappedName);
        }
        // Handle JSR imports
        else if (mappedName.startsWith('jsr:')) {
            if (!this.config.enableJsr) {
                throw new Error('JSR module loading is disabled');
            }
            resolved = this.jsrResolver.resolve(mappedName, parent);
        }
        // Handle relative paths
        else if (mappedName.startsWith('./') || mappedName.startsWith('../')) {
            resolved = this.resolveRelative(mappedName, parent);
        }
        // Handle absolute paths
        else if (isAbsolutePath(mappedName)) {
            resolved = this.resolveAbsolute(mappedName);
        }
        // Handle package imports
        else {
            resolved = this.resolvePackage(mappedName, parent);
        }

        return resolved;
    }

    /**
     * Get matched local path, to load modules exactly
     */
    getLocalPath(protocolPath: string): string {
        // JSR protocol
        if (protocolPath.startsWith('jsr:')) {
            return this.jsrResolver.getLocalPath(protocolPath);
        }

        // HTTP(S) protocol
        if (protocolPath.startsWith('http://') || protocolPath.startsWith('https://')) {
            return this.httpResolver.getLocalPath(protocolPath);
        }

        // Local file path
        return protocolPath;
    }

    /**
     * Apply import map
     */
    private applyImportMap(name: string): string {
        if (!this.config.importMap) {
            return name;
        }

        // Exact match
        if (this.config.importMap[name]) {
            return this.config.importMap[name]!;
        }

        // Prefix match
        for (const [key, value] of Object.entries(this.config.importMap)) {
            if (key.endsWith('/') && name.startsWith(key)) {
                return value + name.substring(key.length);
            }
        }

        return name;
    }

    /**
     * Resolve relative import
     */
    private resolveRelative(name: string, parent: string): string {
        // JSR protocol
        if (parent.startsWith('jsr:')) {
            return this.jsrResolver.resolveRelative(name, parent);
        }

        // HTTP(S) protocol
        if (parent.startsWith('http://') || parent.startsWith('https://')) {
            return this.httpResolver.resolveRelative(name, parent);
        }

        // Local file
        const parentDir = parent ? dirname(parent) : fs.getcwd();
        const fullPath = normalizePath(joinPaths(parentDir, name));
        return this.resolveAbsolute(fullPath);
    }

    /**
     * Resolve absolute path
     */
    private resolveAbsolute(name: string): string {
        const resolved = this.applyPathAlias(name);
        return tryResolveFile(resolved);
    }

    /**
     * Resolve package import
     */
    private resolvePackage(name: string, parent: string): string {
        // Check path aliases
        const aliased = this.applyPathAlias(name);
        if (aliased !== name) {
            try {
                tryResolveFile(aliased);
                return aliased;
            } catch {
                // Fall through to npm resolution
            }
        }

        // NPM package resolution
        return this.npmResolver.resolve(name, parent);
    }

    /**
     * Apply path aliases from tsconfig.json/deno.json
     */
    private applyPathAlias(path: string): string {
        if (!this.config.pathAliases) {
            return path;
        }

        for (const [alias, targets] of Object.entries(this.config.pathAliases)) {
            const cleanAlias = alias.replace(/\/\*$/, '');

            if (path.startsWith(cleanAlias)) {
                const target = targets[0];
                if (!target) continue;

                const cleanTarget = target.replace(/\/\*$/, '');
                const relativePath = path.substring(cleanAlias.length);
                const resolvedPath = this.config.baseUrl
                    ? joinPaths(this.config.baseUrl, cleanTarget, relativePath)
                    : joinPaths(cleanTarget, relativePath);

                return resolvedPath;
            }
        }

        return path;
    }
}