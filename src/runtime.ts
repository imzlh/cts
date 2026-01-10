// runtime.ts - TypeScript Runtime Main Class

import type { RuntimeConfig, NodeResolver } from './types.ts';
import { createConfig } from './config';
import { ModuleResolver } from './resolver';
import { ModuleLoader } from './loader';
import { CodeTransformer } from './transformer';
import { dirname, errMsg } from './utils';

const engine = import.meta.use('engine');
const console = import.meta.use('console');

/**
 * TypeScript Runtime for QuickJS/tjs
 */
export class TypeScriptRuntime {
    private readonly resolver: ModuleResolver;
    private readonly loader: ModuleLoader;
    private readonly transformer: CodeTransformer;
    private mainScript: string | null = null;
    private config: RuntimeConfig;
    private additionalMeta: Record<string, any> = {};

    static SUPPORTED_IMPORT_ATTRS = ['type', 'raw', 'text', 'bytes'];

    constructor(config: RuntimeConfig) {
        this.resolver = new ModuleResolver(config);
        this.transformer = new CodeTransformer();
        this.loader = new ModuleLoader(this.resolver, this.transformer, config);
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
            resolve: (name: string, parent: string, attr: Record<string, any>): string => {
                try {
                    console.debug(`[runtime] Resolving module: name="${name}", parent="${parent}"`);
                    const resolvedProtocol = this.resolver.resolve(name, parent, attr);
                    console.debug(`[runtime] Resolved to: "${resolvedProtocol}"`);
                    if (!this.mainScript) {
                        this.mainScript = resolvedProtocol;
                        this.loader.setMainScript(resolvedProtocol);
                        // @ts-ignore
                        globalThis.__mainScript = resolvedProtocol;
                        console.debug(`[runtime] Main script set to: "${resolvedProtocol}"`);
                    }
                    return resolvedProtocol;
                } catch (error) {
                    console.debug(`[runtime] Resolution failed for "${name}" from "${parent}":`, error);
                    throw new Error(`Cannot resolve module "${name}" from "${parent}": ${errMsg(error)}`);
                }
            },

            load: (modname: string, attr?: Record<string, any>) => {
                const localPath = this.resolver.getLocalPath(modname);
                console.debug(`[runtime] Loading module: localPath="${localPath}", modname="${modname}"`);
                const mod = this.loader.loadModule(localPath, modname, attr);
                this.initModule(mod.meta, modname);
                return mod;
            },

            init: (protocolPath: string, importMeta: Record<string, any>): void => {
                this.initModule(importMeta, protocolPath);
            },

            attrchk: (attr) => {
                if (Object.keys(attr).some(key => !TypeScriptRuntime.SUPPORTED_IMPORT_ATTRS.includes(key))) {
                    // throw an error?
                    console.trace(`Unsupported import attribute: ${JSON.stringify(attr)}`);
                }
            },
        });
    }

    private initModule(importMeta: Record<string, any>, protocolPath: string): void {
        importMeta.url = this.isRemoteProtocol(protocolPath)
            ? protocolPath
            : `file://${protocolPath}`;
        importMeta.filename = protocolPath;
        importMeta.dirname = dirname(protocolPath);

        // No polyfill: use the original import.meta.use
        if (!this.config.polyfill)
            importMeta.use = import.meta.use;

        // Set main flag
        importMeta.main = this.mainScript === protocolPath;

        // add resolve function to import.meta
        importMeta.resolve = (name: string, parent: string, attr?: Record<string, any>): string => {
            return this.resolver.resolve(name, parent, attr);
        };

        // user-defined meta
        Object.assign(importMeta, this.additionalMeta);
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
     * Get main script path
     */
    getMainScript(): string | null {
        return this.mainScript;
    }

    get rtConfig(): RuntimeConfig {
        return this.config;
    }

    set rtConfig(config: Partial<RuntimeConfig>) {
        Object.assign(this.config, config);
    }
}

/**
 * Create and initialize runtime with configuration
 */
export function createRuntime(userConfig: Partial<RuntimeConfig> = {}): TypeScriptRuntime {
    const config = createConfig(userConfig);
    return new TypeScriptRuntime(config);
}