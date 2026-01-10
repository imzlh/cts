// loader.ts - Module Loader

import { type RuntimeConfig, FileType, type ModuleFile } from './types';
import { ModuleResolver } from './resolver';
import { CodeTransformer } from './transformer';
import { readTextFile, dirname, assert } from './utils';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');
const console = import.meta.use('console');
const wasm = import.meta.use('wasm');

/**
 * Module Loader
 * Responsible for loading module files and creating engine modules
 */
export class ModuleLoader {
    private readonly resolver: ModuleResolver;
    private readonly transformer: CodeTransformer;
    private mainScript: string | null = null;

    constructor(
        resolver: ModuleResolver,
        transformer: CodeTransformer,
        private readonly config: RuntimeConfig
    ) {
        this.resolver = resolver;
        this.transformer = transformer;
    }

    /**
     * Load and transform module
     */
    loadModule(localPath: string, protocolPath: string, attr?: Record<string, any>): CModuleEngine.Module {
        // Check if file exists
        let stats;
        try {
            stats = fs.stat(localPath);
        } catch {
            throw new Error(`Module not found: ${localPath}`);
        }

        if (stats.isDirectory) {
            throw new Error(`Cannot load directory as module: ${localPath}`);
        }

        // Handle special import types
        switch (attr?.type) {
            case 'wasm':
                return this.loadWasmModule(localPath, protocolPath);
            case 'bytes':
                return this.loadBytesModule(localPath, protocolPath);
            case 'text':
                return this.loadTextModule(localPath, protocolPath, true);
            case 'raw':
                return this.loadRawModule(localPath, protocolPath);
        }

        // Get file type for default handling
        const fileType = this.resolver.getFileType(localPath);
        
        // Handle binary files
        if (localPath.endsWith('.wasm')) {
            return this.loadWasmModule(localPath, protocolPath);
        }
        if (fileType === FileType.BINARY) {
            return this.loadBinaryModule(localPath, protocolPath);
        }

        // Default: text module
        return this.loadTextModule(localPath, protocolPath);
    }

    /**
     * Load WASM module
     */
    private loadWasmModule(localPath: string, protocolPath: string): CModuleEngine.Module {
        assert(wasm, "WASM support not available");
        console.debug(`[loader] Trying to parse: ${localPath}`);

        const moduleFile = this.loadModuleFile(localPath);
        const wasmBytes = moduleFile.content as Uint8Array;
        
        const mod = engine.Module.create(protocolPath);
        
        try {
            const wasmModule = new wasm.Module(wasmBytes);
            const wasmInstance = new wasm.Instance(wasmModule, {});
            console.debug('[loader] WASM (', protocolPath, ') exports:', wasmInstance.exports);
            for (const item in wasmInstance.exports) {
                console.debug('[loader] wasm export:', item, wasmInstance.exports[item]);
                mod.export(item, wasmInstance.exports[item]);
            }
        } catch (error) {
            console.debug("[loader] Failed to load WASM module:", error);
            throw error;
        }
        
        return mod;
    }

    /**
     * Load binary module
     */
    private loadBinaryModule(localPath: string, protocolPath: string): CModuleEngine.Module {
        const moduleFile = this.loadModuleFile(localPath);
        const mod = engine.Module.create(protocolPath);
        mod.export('default', new Uint8Array(moduleFile.content as Uint8Array));
        
        return mod;
    }

    /**
     * Load bytes module
     */
    private loadBytesModule(localPath: string, protocolPath: string): CModuleEngine.Module {
        const moduleFile = this.loadModuleFile(localPath);
        const bytes = moduleFile.content as Uint8Array;
        const mod = engine.Module.create(protocolPath);
        mod.export('default', bytes);
        return mod;
    }

    /**
     * Load raw module
     */
    private loadRawModule(localPath: string, protocolPath: string): CModuleEngine.Module {
        const fileType = this.resolver.getFileType(localPath);
        return fileType === FileType.BINARY 
            ? this.loadBytesModule(localPath, protocolPath)
            : this.loadTextModule(localPath, protocolPath, true);
    }

    /**
     * Load text module with JSC caching
     */
    private loadTextModule(localPath: string, protocolPath: string, rawText?: boolean): CModuleEngine.Module {
        const isCacheable = localPath.startsWith(this.config.cacheDir);

        // Check JSC cache first
        const jscPath = localPath + '.jsc';
        if (isCacheable && fs.exists(jscPath)) {
            try {
                const buf = fs.readFile(jscPath);
                return engine.deserialize(new Uint8Array(buf));
            } catch (error) {
                console.warn(`JSC cache invalid for ${jscPath}, recompiling...`);
            }
        }

        // Load and compile source
        const content = readTextFile(localPath);
        let code: string;
        
        if (rawText === true) {
            code = `export default ${JSON.stringify(content)};`;
        } else {
            code = this.transformer.transform(content, localPath);
        }
        
        const mod = new engine.Module(code, protocolPath);
        
        // Write JSC cache if is cts cache file
        if (isCacheable)
            try {
                const dir = dirname(localPath);
                try {
                    fs.stat(dir);
                } catch {
                    fs.mkdir(dir);
                }
                fs.writeFile(jscPath, mod.dump());
            } catch (error) {
                console.warn(`Failed to write JSC cache for ${localPath}:`, error);
            }
        
        return mod;
    }

    /**
     * Load module file with appropriate type handling
     */
    private loadModuleFile(path: string): ModuleFile {
        const type = this.resolver.getFileType(path);
        const content = fs.readFile(path);
        
        return {
            path,
            type,
            content: type === FileType.BINARY 
                ? new Uint8Array(content)
                : engine.decodeString(content)
        };
    }

    /**
     * Get main script path
     */
    getMainScript(): string | null {
        return this.mainScript;
    }

    /**
     * Set main script path
     */
    setMainScript(path: string): void {
        this.mainScript = path;
    }
}