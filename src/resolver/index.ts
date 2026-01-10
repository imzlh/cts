// resolver/index.ts - Main Module Resolver

import { type RuntimeConfig, type NodeResolver, FileType } from '../types';
import { dirname, tryResolveFile, isAbsolutePath, normalizePath, joinPaths } from '../utils';
import { HttpResolver } from './http';
import { JsrResolver } from './jsr';
import { NodeModuleResolver } from './node';
import { NpmResolver } from './npm';
import { FileResolver } from './file';
import { DataResolver } from './data';
import type { BaseResolver } from './base';

const os = import.meta.use('os');

interface ResolverEntry {
    resolver: BaseResolver;
    enabled: boolean;
}

/**
 * Main protocol resolver class
 * Responsibility: Convert various protocol URLs to local file paths
 */
export class ModuleResolver {
    private readonly resolverRegistry: Map<string, ResolverEntry> = new Map();

    constructor(private readonly config: RuntimeConfig) {
        this.registerResolvers();
    }

    private registerResolvers(): void {
        const registrations: Array<[BaseResolver, keyof RuntimeConfig]> = [
            [new HttpResolver(this.config), 'enableHttp'],
            [new JsrResolver(this.config), 'enableJsr'],
            [new NodeModuleResolver(this.config), 'enableNode'],
            [new FileResolver(this.config), 'enableHttp'], // Use enableHttp for file:// protocol
            [new DataResolver(this.config), 'enableHttp']  // Use enableHttp for data: protocol
        ];

        for (const [resolver, flag] of registrations) {
            this.registerResolver(resolver, flag);
        }
        // npm is enabled by default
        this.resolverRegistry.set('npm', {
            resolver: new NpmResolver(this.config),
            enabled: true
        });
    }

    private registerResolver(resolver: BaseResolver, flag: keyof RuntimeConfig): void {
        for (const protocol of resolver.protocol) {
            this.resolverRegistry.set(protocol, {
                resolver,
                enabled: this.config[flag] as boolean
            });
        }
    }

    registerNodeResolver(resolver: NodeResolver): void {
        const entry = this.resolverRegistry.get('node');
        if (entry?.resolver instanceof NodeModuleResolver) {
            (entry.resolver as NodeModuleResolver).registerResolver(resolver);
        }
    }

    /**
     * Resolve module identifier to local path
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): string {
        const mappedName = this.applyImportMap(specifier);

        if (this.isRelativePath(mappedName)) {
            return this.resolveRelative(mappedName, parent!, attr);
        }

        if (this.isAbsolutePath(mappedName)) {
            return this.resolveAbsolute(mappedName, parent, attr);
        }

        return this.resolveByProtocol(mappedName, parent, attr);
    }

    private resolveByProtocol(name: string, parent?: string, attr?: Record<string, any>): string {
        const protocol = this.extractProtocol(name);
        const entry = this.resolverRegistry.get(protocol);

        if (!entry) {
            return this.resolvePackage(name, parent!, attr);
        }

        if (!entry.enabled) {
            throw new Error(`${this.getProtocolDisplayName(protocol)} module loading is disabled`);
        }

        const { resolver } = entry;

        if (protocol === 'node') {
            return (resolver as NodeModuleResolver).resolve(name);
        }

        return resolver.resolve(name, parent, attr);
    }

    /**
     * Get local path for protocol URL
     */
    getLocalPath(protocolPath: string): string {
        const protocol = this.extractProtocol(protocolPath);
        const entry = this.resolverRegistry.get(protocol);

        return entry?.resolver.getLocalPath(protocolPath) ?? protocolPath;
    }
    
    /**
     * Get file type
     */
    getFileType(path: string): FileType {
        const protocol = this.extractProtocol(path);
        const entry = this.resolverRegistry.get(protocol);
        
        if (entry?.resolver) {
            return entry.resolver.getFileType(path);
        }
        
        // Default file type check
        if (path.endsWith('.wasm')) {
            return FileType.BINARY;
        }
        
        return FileType.TEXT;
    }

    /**
     * Resolve relative path
     */
    resolveRelative(name: string, parent: string, attr?: Record<string, any>): string {
        if (!parent) {
            const parentDir = os.cwd;
            return tryResolveFile(normalizePath(joinPaths(parentDir, name)));
        }

        const protocol = this.extractProtocol(parent);
        const entry = this.resolverRegistry.get(protocol);

        if (entry?.resolver) {
            try {
                return entry.resolver.resolve(name, parent, attr);
            } catch {
                // Fallback to file system resolution
            }
        }

        const parentDir = dirname(parent);
        return tryResolveFile(normalizePath(joinPaths(parentDir, name)));
    }

    /**
     * Resolve absolute path
     */
    resolveAbsolute(name: string, parent?: string, attr?: Record<string, any>): string {
        const aliased = this.applyPathAlias(name);
        
        if (aliased !== name) {
            try {
                return tryResolveFile(aliased);
            } catch {
                // Continue with original path
            }
        }

        if (parent) {
            const protocol = this.extractProtocol(parent);
            const entry = this.resolverRegistry.get(protocol);

            if (entry?.resolver) {
                try {
                    return entry.resolver.resolve(name, parent, attr);
                } catch {
                    // Fallback to file system resolution
                }
            }
        }

        return aliased;
    }

    private extractProtocol(url: string): string {
        const match = url.match(/^([a-z]+):/);
        return match ? `${match[1]}` : '';
    }

    private applyImportMap(name: string): string {
        if (!this.config.importMap) {
            return name;
        }

        if (this.config.importMap[name]) {
            return this.config.importMap[name]!;
        }

        for (const [key, value] of Object.entries(this.config.importMap)) {
            if (key.endsWith('/') && name.startsWith(key)) {
                return value + name.substring(key.length);
            }
        }

        return name;
    }

    private resolvePackage(name: string, parent: string, attr?: Record<string, any>): string {
        const aliased = this.applyPathAlias(name);

        if (aliased !== name) {
            try {
                return tryResolveFile(aliased);
            } catch {
                // Fallback to npm resolution
            }
        }

        const entry = this.resolverRegistry.get('npm');
        return entry?.resolver.resolve(name, parent, attr) ?? name;
    }

    private applyPathAlias(path: string): string {
        if (!this.config.pathAliases) {
            return path;
        }

        for (const [alias, targets] of Object.entries(this.config.pathAliases)) {
            const cleanAlias = alias.replace(/\/\*$/, '');

            if (path.startsWith(cleanAlias)) {
                const target = targets[0]!;
                if (alias.endsWith('/*')) {
                    return target + path.substring(cleanAlias.length);
                } else {
                    return target;
                }
            }
        }

        return path;
    }

    private isRelativePath(path: string): boolean {
        return path.startsWith('./') || path.startsWith('../');
    }

    private isAbsolutePath(path: string): boolean {
        return isAbsolutePath(path);
    }

    private getProtocolDisplayName(protocol: string): string {
        switch (protocol) {
            case 'http':
            case 'https':
                return 'HTTP';
            case 'jsr':
                return 'JSR';
            case 'npm':
                return 'NPM';
            case 'node':
                return 'Node.js';
            default:
                return protocol.toUpperCase();
        }
    }
}