import { type RuntimeConfig, FileType, type ModuleFile, ModuleType } from './types';
import { ModuleResolver } from './resolver';
import { CodeTransformer } from './transformer';
import { readTextFile, dirname, assert, ensureDir, writeTextFile, joinPaths } from './utils';
import { createLoader as createCJSLoader } from './commonjs';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');
const console = import.meta.use('console');
const wasm = import.meta.use('wasm');

function deleteJscRecursive(dir: string) {
    for (const entry of fs.readdir(dir)) {
        const path = joinPaths(dir, entry);
        if (fs.stat(path).isDirectory) {
            deleteJscRecursive(path);
        } else if (path.endsWith('.jsc')) {
            fs.unlink(path);
            console.debug(`[loader] Deleted cache file ${path}`);
        }
    }
}

// NEVER remove this line, as will cause GC and SEGV
const store: CModuleEngine.Module[] = [];

/**
 * Module Loader
 * Responsible for loading module files and creating engine modules
 */
export class ModuleLoader {
    private readonly resolver: ModuleResolver;
    private readonly transformer: CodeTransformer;
    private mainScript: string | null = null;
    private cjsLoader = createCJSLoader({ debug: false });
    
    // Cache module type to avoid repeated detection
    private moduleTypeCache = new Map<string, ModuleType>();

    static verifyCacheDir(dir: string) {
        if (!fs.exists(dir)) {
            this.initCacheDir(dir);
            return;
        }
        assert(fs.stat(dir).isDirectory, `Cache directory exists but is not a directory: ${dir}`);

        let cver = '';
        try {
            cver = readTextFile(joinPaths(dir, 'version'));
        } catch {
            // ignore
        }
        if (cver !== engine.versions.quickjs) {
            deleteJscRecursive(dir);
            writeTextFile(joinPaths(dir, 'version'), engine.versions.quickjs);
        }
    }

    static initCacheDir(dir: string) {
        ensureDir(dir);
        writeTextFile(joinPaths(dir, 'version'), engine.versions.quickjs);
    }

    constructor(
        resolver: ModuleResolver,
        transformer: CodeTransformer,
        private readonly config: RuntimeConfig
    ) {
        this.resolver = resolver;
        this.transformer = transformer;
    }

    /**
     * Get module type with caching
     * Now gets type from resolver.getLocalPath result
     */
    private getModuleTypeFromResolver(protocolPath: string): ModuleType {
        // Check cache first
        const cached = this.moduleTypeCache.get(protocolPath);
        if (cached !== undefined) return cached;

          let result: ModuleType | undefined = undefined;
        // 1. Check query string hint
        const qIndex = protocolPath.indexOf('?');
        if (qIndex !== -1) {
            const typeHint = protocolPath.substring(qIndex + 1);
            if (typeHint === 'commonjs') result = ModuleType.CJS;
            else if (typeHint === 'module') result = ModuleType.ESM;
        }
        
        // 2. Fast path: check extension
        if (result === undefined) {
            const ext = protocolPath.slice(protocolPath.lastIndexOf('.'));
            if (ext === '.mjs') result = ModuleType.ESM;
            else if (ext === '.cjs') result = ModuleType.CJS;
        }
        
        // 3. Default to ESM if not determined
        if (result === undefined) {
            result = ModuleType.ESM;
        }

        // Cache and return
        this.moduleTypeCache.set(protocolPath, result);
        return result;
    }

    /**
     * Load and transform module
     */
    loadModule(localPath: string, protocolPath: string, injectImportMeta: Record<string, any> = {}, moduleType?: ModuleType): CModuleEngine.Module {
        // Check if file exists
        let stats;
        try {
            stats = fs.stat(localPath);
        } catch (error) {
            throw new Error(`Module not found: ${localPath}`);
        }

        if (stats.isDirectory) {
            throw new Error(`Cannot load directory as module: ${localPath}`);
        }

        let type = '';
        const qIndex = protocolPath.lastIndexOf('?');
        if (qIndex != -1) {
            type = protocolPath.substring(qIndex + 1);
        }

        // Handle explicit type hints first
        if (type === 'commonjs') {
            return this.loadCJSModule(localPath, protocolPath, injectImportMeta);
        }
        if (type === 'module') {
            return this.loadESMModule(localPath, protocolPath, injectImportMeta);
        }

        // Handle special import types
        let modTmp: CModuleEngine.Module | null = null;
        switch (type) {
            case 'wasm':
                modTmp = this.loadWasmModule(localPath, protocolPath);
                break;
            case 'bytes':
                modTmp = this.loadBytesModule(localPath, protocolPath);
                break;
            case 'text':
                modTmp = this.loadTextModule(localPath, protocolPath);
                break;
            case 'raw':
                modTmp = this.loadRawModule(localPath, protocolPath);
                break;
        }

        if (modTmp) {
            Object.assign(modTmp.meta, injectImportMeta);
            return modTmp;
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

        // Use provided module type or detect from extension
        const modType = moduleType ?? this.getModuleTypeFromResolver(protocolPath);
        if (modType === ModuleType.CJS) {
            return this.loadCJSModule(localPath, protocolPath, injectImportMeta);
        }
        return this.loadESMModule(localPath, protocolPath, injectImportMeta);
    }

    private createModule(name: string) {
        const m = engine.Module.create(name);
        store.push(m);      // manage lifecycle
        return m;
    }

    /**
     * Load WASM module
     */
    private loadWasmModule(localPath: string, protocolPath: string): CModuleEngine.Module {
        assert(wasm, "WASM support not available");
        console.debug(`[loader] Trying to parse: ${localPath}`);

        const moduleFile = this.loadModuleFile(localPath);
        const wasmBytes = moduleFile.content as Uint8Array;

        const mod = this.createModule(protocolPath);

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
        const mod = this.createModule(protocolPath);
        mod.export('default', new Uint8Array(moduleFile.content as Uint8Array));

        return mod;
    }

    /**
     * Load bytes module
     */
    private loadBytesModule(localPath: string, protocolPath: string): CModuleEngine.Module {
        const moduleFile = this.loadModuleFile(localPath);
        const bytes = moduleFile.content as Uint8Array;
        const mod = this.createModule(protocolPath);
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
            : this.loadTextModule(localPath, protocolPath);
    }

    private loadTextModule(localPath: string, protocolPath: string): CModuleEngine.Module {
        const file = readTextFile(localPath);
        const mod = this.createModule(protocolPath);
        mod.export('default', file);
        return mod;
    }

    /**
     * Load ESM module (JavaScript/TypeScript)
     */
    private loadESMModule(localPath: string, protocolPath: string, injectImportMeta: Record<string, any>): CModuleEngine.Module {
        const isCacheable = !this.config.disableCache && localPath.startsWith(this.config.cacheDir);
        console.debug(`[loader] Loading ESM: ${localPath}`);

        // Check JSC cache first
        const jscPath = localPath + '.jsc';
        if (isCacheable && fs.exists(jscPath)) {
            const buf = fs.readFile(jscPath);
            let mod;
            try {
                mod = engine.deserialize(new Uint8Array(buf));
            } catch {
                // Ignore, will recompile
            }
            if (mod) {
                Object.assign(mod.meta, injectImportMeta);
                return mod;
            }
        }

        // Load and compile source
        const content = readTextFile(localPath);
        const code = this.transformer.transform(content, localPath);
        const mod = new engine.Module(code, protocolPath);

        // Write JSC cache
        if (isCacheable) {
            try {
                ensureDir(dirname(localPath));
                fs.writeFile(jscPath, mod.dump());
            } catch (error) {
                console.warn(`Failed to write JSC cache for ${localPath}:`, error);
            }
        }

        Object.assign(mod.meta, injectImportMeta);
        return mod;
    }

    /**
     * Load CommonJS module using commonjs.ts
     * Wraps CJS module.exports as ESM default export
     */
    private loadCJSModule(localPath: string, protocolPath: string, injectImportMeta: Record<string, any>): CModuleEngine.Module {
        console.debug(`[loader] Loading CJS: ${localPath}`);

        // Use commonjs.ts to load the module
        const cjsRequire = this.cjsLoader.createRequireFunction(localPath);

        // Load the CJS module
        let cjsExports: any;
        try {
            cjsExports = cjsRequire(localPath);
        } catch (error) {
            throw new Error(`Failed to load CJS module ${localPath}: ${error}`);
        }

        // Wrap CJS exports as ESM module
        const mod = this.createModule(protocolPath);
        Object.assign(mod.meta, injectImportMeta);

        // Export all properties from CJS module
        if (cjsExports && typeof cjsExports === 'object') {
            for (const key of Object.keys(cjsExports)) {
                mod.export(key, cjsExports[key]);
            }
        }

        // Always export default as the full exports object
        mod.export('default', cjsExports);

        return mod;
    }

    preCacheModule(path: string, parent: string): void {
        // CJS pre-cache handled by commonjs.ts
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
