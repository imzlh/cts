// resolvers/node.ts - Node.js Module Resolver

import type { RuntimeConfig, NodeResolver } from '../types';
import {
    joinPaths,
    dirname,
    tryResolveFile,
    normalizePath,
    assert,
    readTextFile
} from '../utils';
import { BaseResolver, type ResolveResult, type LocalPathResult, ModuleType } from './base.js';

const fs = import.meta.use('fs');
const console = import.meta.use('console');

/**
 * Node.js Module Resolver
 */
export class NodeModuleResolver extends BaseResolver {
    private customResolver: NodeResolver | null = null;

    readonly protocol = ['node'];

    constructor(private readonly config: RuntimeConfig) {
        super();
    }

    /**
     * Register custom node resolver
     */
    registerResolver(resolver: NodeResolver): void {
        console.debug('[Node] Registering custom resolver', resolver);
        this.customResolver = resolver;
    }

    /**
     * Resolve node module
     * Node polyfills are loaded as ESM (TypeScript)
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): ResolveResult {
        // Remove node: prefix
        if (specifier.startsWith('node:')) {
            specifier = specifier.substring(5);
        }

        // Try custom resolver first
        if (this.customResolver) {
            const customPath = this.customResolver(specifier, parent);
            if (customPath) {
                console.debug(`[Node] Custom resolver returned: ${customPath}`);
                const moduleType = this.detectPolyfillType(customPath);
                return { path: customPath, isCjs: moduleType === ModuleType.CJS };
            }
        }

        // Check if polyfill exists and determine type
        const localPathResult = this.getLocalPath(`node:${specifier}`);
        const isCjs = localPathResult.moduleType === ModuleType.CJS;

        return { path: `node:${specifier}`, isCjs };
    }

    /**
     * Check module type based on polyfill file extension
     */

    private detectPolyfillType(localPath: string): ModuleType {
        // Check polyfill file extension
        if (localPath.endsWith('.mjs')) return ModuleType.ESM;
        if (localPath.endsWith('.cjs')) return ModuleType.CJS;
        if (localPath.endsWith('.ts')) return ModuleType.ESM;
        if (localPath.endsWith('.js')) {
            // For .js, check package.json in node/ directory
            const nodeDir = joinPaths(this.config.cacheDir, 'node');
            try {
                const pkgPath = joinPaths(nodeDir, 'package.json');
                if (fs.exists(pkgPath)) {
                    const pkg = JSON.parse(readTextFile(pkgPath));
                    return pkg.type === 'module' ? ModuleType.ESM : ModuleType.CJS;
                }
            } catch {}
            return ModuleType.CJS; // Default to CJS for .js
        }
        return ModuleType.ESM; // Default to ESM for unknown
    }

    getLocalPath(url: string): LocalPathResult {
        if (!url.startsWith('node:')) {
            // Not a node: URL, return as-is
            return { path: url };
        }

        // Try to resolve to local polyfill
        console.debug(`Resolving node module: ${url}`);
        const specifier = url.substring(5);

        // Try custom resolver first
        if (this.customResolver) {
            const customPath = this.customResolver(specifier);
            if (customPath) {
                console.debug(`[Node] Custom resolver returned: ${customPath}`);
                const moduleType = this.detectPolyfillType(customPath);
                return { path: customPath, moduleType };
            }
        }

        // Default resolution
        let fpath;
        if (url.includes('/')) {
            // multi-part specifier
            fpath = joinPaths(this.config.cacheDir, 'node', specifier + '.ts');
        } else {
            fpath = joinPaths(this.config.cacheDir, 'node', specifier, '/index.ts');
        }

        const moduleType = this.detectPolyfillType(fpath);
        return { path: fpath, moduleType };
    }
}
