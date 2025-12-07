// resolvers/node.ts - Node.js Module Resolver

import type { RuntimeConfig, NodeResolver } from '../types.ts';
import { joinPaths, tryResolveFile } from '../utils';

const fs = import.meta.use('fs');

/**
 * Node.js Builtin Module Resolver
 */
export class NodeModuleResolver {
    private customResolver: NodeResolver | null = null;

    constructor(private readonly config: RuntimeConfig) { }

    /**
     * Register custom node resolver
     */
    registerResolver(resolver: NodeResolver): void {
        this.customResolver = resolver;
    }

    /**
     * Resolve node: protocol imports
     * Format: node:module_name
     */
    resolve(specifier: string): string {
        const moduleName = specifier.substring(5); // Remove 'node:' prefix

        // Check custom resolver
        // TODO: this will break node protocol, fix it?
        if (this.customResolver) {
            const resolved = this.customResolver(moduleName);
            if (resolved) {
                return resolved;
            }
        }

        // Try default node cache directory
        const nodeCacheDir = joinPaths(this.config.cacheDir, 'node');
        const defaultPath = joinPaths(nodeCacheDir, moduleName);

        try {
            return tryResolveFile(defaultPath);
        } catch {
            throw new Error(
                `Node.js module "${moduleName}" not found. ` +
                `Please install it to ${nodeCacheDir}/ or register a custom resolver using runtime.registerNodeResolver()`
            );
        }
    }

    /**
     * Check if a Node.js module is available
     */
    has(moduleName: string): boolean {
        const specifier = `node:${moduleName}`;
        try {
            this.resolve(specifier);
            return true;
        } catch {
            return false;
        }
    }
}