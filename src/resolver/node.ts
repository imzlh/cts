// resolvers/node.ts - Node.js Module Resolver

import type { RuntimeConfig, NodeResolver } from '../types';
import {
    joinPaths,
    dirname,
    tryResolveFile,
    normalizePath
} from '../utils';
import { BaseResolver } from './base.js';

const fs = import.meta.use('fs');
const sys = import.meta.use('sys');
const os = import.meta.use('os');

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
        this.customResolver = resolver;
    }

    /**
     * Resolve node module
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): string {
        // Remove node: prefix
        if (specifier.startsWith('node:')) {
            specifier = specifier.substring(5);
        }

        // Built-in modules are handled by the runtime
        return `node:${specifier}`;
    }

    getLocalPath(url: string): string {
        // Node built-in modules don't have local paths
        return url;
    }
}