import { type RuntimeConfig, type NodeResolver, FileType } from '../types';
import { dirname, tryResolveFile, isAbsolutePath, normalizePath, joinPaths, assert } from '../utils';
import { HttpResolver } from './http';
import { JsrResolver } from './jsr';
import { NodeModuleResolver } from './node';
import { NpmResolver } from './npm';
import { FileResolver } from './file';
import { DataResolver } from './data';
import type { BaseResolver, ResolveResult, LocalPathResult } from './base';

const os = import.meta.use('os');
const console = import.meta.use('console');

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
    private mainEntry: string;

    constructor(private readonly config: RuntimeConfig) {
        this.mainEntry = this.config._ || '';
        this.registerResolvers();
    }

    setMainEntry(entry: string): void {
        this.mainEntry = entry;
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
        assert(entry, 'Node resolver is not registered');
        (entry.resolver as NodeModuleResolver).registerResolver(resolver);
    }

    /**
     * Resolve module specifier
     * Returns path string for backward compatibility
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): string {
        const result = this.resolveWithType(specifier, parent, attr);
        return result.path;
    }

    /**
     * Resolve with module type information
     */
    resolveWithType(specifier: string, parent?: string, attr?: Record<string, any>): ResolveResult {
        // Apply import map first
        const mappedName = this.applyImportMap(specifier);

        // Check if mapped name has a protocol (e.g., npm:, jsr:, http:)
        const protocol = this.extractProtocol(mappedName);
        if (protocol) {
            return this.resolveByProtocol(mappedName, parent, attr);
        }

        // Handle relative paths
        if (this.isRelativePath(mappedName)) {
            console.debug(`[resolver] Resolving relative path: ${mappedName}`);
            const path = this.resolveRelative(mappedName, parent!, attr);
            return { path };
        }

        // Handle absolute paths
        if (this.isAbsolutePath(mappedName)) {
            console.debug(`[resolver] Resolving absolute path: ${mappedName}`);
            const path = this.resolveAbsolute(mappedName, parent, attr);
            return { path };
        }

        // Handle bare specifiers (package names)
        const path = this.resolvePackage(mappedName, parent!, attr);
        return { path };
    }

    private resolveByProtocol(name: string, parent?: string, attr?: Record<string, any>): ResolveResult {
        const protocol = this.extractProtocol(name);
        const entry = this.resolverRegistry.get(protocol);

        if (!entry) {
            const result = this.resolvePackage(name, parent!, attr);
            return { path: result };
        }

        if (!entry.enabled) {
            throw new Error(`${this.getProtocolDisplayName(protocol)} module loading is disabled`);
        }

        const { resolver } = entry;
        return resolver.resolve(name, parent, attr);
    }

    /**
     * Get local path for protocol URL
     */
    getLocalPath(protocolPath: string): LocalPathResult {
        const protocol = this.extractProtocol(protocolPath);
        const entry = this.resolverRegistry.get(protocol);

        return entry?.resolver.getLocalPath(protocolPath) ?? { path: protocolPath };
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
                const result = entry.resolver.resolve(name, parent, attr);
                return typeof result === 'string' ? result : result.path;
            } catch (error) {
                // Fallback to file system resolution
                console.debug(`[resolver] Protocol resolver failed for "${name}", falling back to file system: `, error);
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
            } catch (error) {
                // Continue with original path
                console.debug(`[resolver] Path alias resolution failed for "${aliased}": ${error}`);
            }
        }

        if (parent) {
            const protocol = this.extractProtocol(parent);
            const entry = this.resolverRegistry.get(protocol);

            if (entry?.resolver) {
                try {
                    const result = entry.resolver.resolve(name, parent, attr);
                    return typeof result === 'string' ? result : result.path;
                } catch (error) {
                    // Fallback to file system resolution
                    console.debug(`[resolver] Protocol resolver failed for "${name}":`, error);
                }
            }
        }

        return aliased;
    }

    private extractProtocol(url: string): string {
        const match = url.match(/^([a-z]{2,8}):/);
        return match ? `${match[1]}` : '';
    }

    private applyImportMap(name: string): string {
        if (!this.config.importMap) {
            return name;
        }

        // Direct match
        if (this.config.importMap[name]) {
            return this.config.importMap[name]!;
        }

        // Prefix match for paths
        for (const [key, value] of Object.entries(this.config.importMap)) {
            if (key.endsWith('/') && name.startsWith(key)) {
                return value + name.substring(key.length);
            }
        }

        return name;
    }

    private resolvePackage(name: string, parent: string, attr?: Record<string, any>): string {
        // First check if this is a bare specifier that has been mapped to a protocol
        const protocol = this.extractProtocol(name);
        if (protocol) {
            const result = this.resolveByProtocol(name, parent, attr);
            return typeof result === 'string' ? result : result.path;
        }
        
        // Apply path aliases
        const aliased = this.applyPathAlias(name);

        if (aliased !== name) {
            try {
                return tryResolveFile(aliased);
            } catch (error) {
                // Fallback to npm resolution
                console.debug(`[resolver] Path alias resolution failed for "${aliased}": ${error}`);
            }
        }

        // Default to npm resolution
        const entry = this.resolverRegistry.get('npm');
        if (entry?.resolver) {
            const result = entry.resolver.resolve(name, parent, attr);
            return typeof result === 'string' ? result : result.path;
        }
        return name;
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