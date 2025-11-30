// runtime.ts - TypeScript Runtime Main Class

import type { RuntimeConfig, NodeResolver } from './types.ts';
import { createConfig } from './config';
import { ModuleResolver } from './resolver';
import { CodeTransformer } from './transformer';
import { readTextFile, dirname, errMsg } from './utils';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');

/**
 * TypeScript Runtime for QuickJS/tjs
 */
export class TypeScriptRuntime {
    private readonly resolver: ModuleResolver;
    private readonly transformer: CodeTransformer;
    private mainScript: string | null = null;
    private config: RuntimeConfig;
    private additionalMeta: Record<string, any> = {};

    constructor(config: RuntimeConfig) {
        this.resolver = new ModuleResolver(config);
        this.transformer = new CodeTransformer();
        this.config = config;
        this.setupModuleLoader();
    }

    /**
     * Register Node.js builtin modules resolver
     */
    registerNodeResolver(resolver: NodeResolver): void {
        this.resolver.registerNodeResolver(resolver);
    }

    /**
     * Set up the QuickJS module loader hooks
     */
    private setupModuleLoader(): void {
        engine.onModule({
            resolve: (name: string, parent: string): string => {
                try {
                    const resolvedProtocol = this.resolver.resolve(name, parent);
                    return resolvedProtocol;
                } catch (error) {
                    throw new Error(`Cannot resolve module "${name}" from "${parent}": ${errMsg(error)}`);
                }
            },

            load: (modname: string) => {
                const localPath = this.resolver.getLocalPath(modname);
                return this.loadModule(localPath, modname);
            },

            init: (protocolPath: string, importMeta: Record<string, any>): void => {
                importMeta.url = this.isRemoteProtocol(protocolPath)
                    ? protocolPath
                    : `file://${protocolPath}`;
                importMeta.filename = protocolPath;
                importMeta.dirname = dirname(protocolPath);

                // No polyfill: use the original import.meta.use
                if (!this.config.polyfill)
                    importMeta.use = import.meta.use;

                // Set main flag
                if (!this.mainScript) {
                    importMeta.main = true;
                    this.mainScript = protocolPath;
                } else {
                    importMeta.main = false;
                }

                // add resolve function to import.meta
                importMeta.resolve = (name: string, parent: string): string => {
                    return this.resolver.resolve(name, parent);
                };

                // user-defined meta
                Object.assign(importMeta, this.additionalMeta);
            }
        });
    }

    /**
     * Check if path is a remote protocol
     */
    private isRemoteProtocol(path: string): boolean {
        return path.startsWith('jsr:') ||
            path.startsWith('http://') ||
            path.startsWith('https://');
    }

    /**
     * Load and transform a module
     */
    private loadModule(localPath: string, protocolPath: string): string {
        if (!fs.exists(localPath)) {
            throw new Error(`Module not found: ${localPath}`);
        }

        const stats = fs.stat(localPath);
        if (stats.isDirectory) {
            throw new Error(`Cannot load directory as module: ${localPath}`);
        }

        // Read source code
        const sourceCode = readTextFile(localPath);

        // Transform code
        const transformedCode = this.transformer.transform(sourceCode, protocolPath);
        return transformedCode;
    }

    /**
     * Clear resolution cache
     */
    clearCache(): void {
        this.resolver.clearCache();
    }

    /**
     * Get main script path
     */
    getMainScript(): string | null {
        return this.mainScript;
    }
}

/**
 * Create and initialize runtime with configuration
 */
export function createRuntime(userConfig: Partial<RuntimeConfig> = {}): TypeScriptRuntime {
    const config = createConfig(userConfig);
    return new TypeScriptRuntime(config);
}