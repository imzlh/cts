/**
 * CommonJS Module System Implementation for QuickJS/circu.js
 *
 * Features:
 * - Full CommonJS compatibility (require, module.exports, exports)
 * - npm module resolution (node_modules)
 * - Circular dependency support
 * - JSON module loading
 * - Package.json parsing (main, exports fields)
 * - Module caching
 * - TypeScript support
 *
 * @module commonjs
 */

import { dirname, extname, isAbsolutePath, joinPaths, resolvePath } from "./utils";
import {
    readPackageJson,
    resolvePackageExports as resolvePkgExports,
    createResolveContext,
    clearPackageCache as clearPkgCache
} from "./package";
import type { PackageJson } from './types';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
const console = import.meta.use('console');

// ============================================================================
// Type Definitions
// ============================================================================

interface Module {
    /** Module identifier (absolute path) */
    id: string;
    /** Absolute path to the module file */
    filename: string;
    /** Whether the module has finished loading */
    loaded: boolean;
    /** The exports object */
    exports: any;
    /** The require function for this module */
    require: RequireFunction;
    /** Modules required by this module */
    children: Module[];
    /** Parent module that required this module */
    parent: Module | null;
    /** Module search paths */
    paths: string[];
}

interface RequireFunction {
    /** Load a module */
    (id: string): any;
    /** Resolve module path without loading */
    resolve: (id: string, options?: ResolveOptions) => string;
    /** Module cache */
    cache: Map<string, Module>;
    /** Main module */
    main: Module | null;
    /** Extension handlers */
    extensions: Record<string, (module: Module, filename: string) => void>;
}

interface ResolveOptions {
    /** Paths to search for modules */
    paths?: string[];
}

interface LoaderOptions {
    /** Enable debug logging */
    debug?: boolean;
    /** Custom module extensions */
    extensions?: string[];
    /** Enable TypeScript support */
    typescript?: boolean;
    /** Custom require paths */
    paths?: string[];
}

// ============================================================================
// Module System State
// ============================================================================

class ModuleLoader {
    /** Module cache: filepath -> module object */
    private cache = new Map<string, Module>();

    /** Currently loading modules (for circular dependency detection) */
    private loading = new Set<string>();

    /** Main module */
    private mainModule: Module | null = null;

    /** Loader options */
    private options: LoaderOptions;

    /** Built-in module names */
    private builtinModules = new Set([
        'fs', 'path', 'os', 'util', 'events', 'stream', 'buffer',
        'crypto', 'dns', 'http', 'https', 'net', 'tls', 'url',
        'querystring', 'zlib', 'process', 'child_process'
    ]);

    constructor(options: LoaderOptions = {}) {
        this.options = {
            debug: false,
            extensions: ['.js', '.json', '.ts', '.mjs', '.cjs'],
            typescript: false,
            paths: [],
            ...options
        };
    }

    /**
     * Log debug message
     */
    private log(...args: any[]): void {
        if (this.options.debug) {
            console.log('[CommonJS]', ...args);
        }
    }

    /**
     * Create a new module object
     */
    private createModule(filename: string, parent: Module | null = null): Module {
        const module: Module = {
            id: filename,
            filename: filename,
            loaded: false,
            exports: {},
            require: null as any, // Will be set below
            children: [],
            parent: parent,
            paths: this.getModulePaths(filename)
        };

        module.require = this.createRequire(filename, module);

        if (parent) {
            parent.children.push(module);
        }

        return module;
    }

    /**
     * Get module search paths for a given file
     */
    private getModulePaths(filename: string): string[] {
        const paths: string[] = [];
        let dir = dirname(filename);

        // Add custom paths
        if (this.options.paths) {
            paths.push(...this.options.paths);
        }

        // Walk up directory tree looking for node_modules
        while (dir !== '/') {
            paths.push(joinPaths(dir, 'node_modules'));
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }

        // Add global node_modules
        paths.push('/usr/lib/node_modules');
        paths.push('/usr/local/lib/node_modules');

        return paths;
    }

    /**
     * Resolve package exports field using shared utility
     */
    private resolvePackageExports(
        pkg: PackageJson,
        basePath: string,
        subpath: string = '.'
    ): string | null {
        const context = createResolveContext(basePath, { forceCjs: true });
        if (!context) return null;

        // Update pkgJson in context
        context.pkgJson = pkg;

        return resolvePkgExports(context, subpath);
    }

    /**
     * Try to resolve as a file with various extensions
     */
    private tryResolveAsFile(filepath: string): string | null {
        // Try exact path
        try {
            if (fs.exists(filepath)) {
                const stats = fs.stat(filepath);
                if (stats.isFile) return fs.realpath(filepath);
            }
        } catch (e) {
            // Path doesn't exist or access denied
        }

        // Try with extensions
        const extensions = this.options.extensions || ['.js', '.json', '.node'];
        for (const ext of extensions) {
            try {
                const withExt = filepath + ext;
                if (fs.exists(withExt)) {
                    const stats = fs.stat(withExt);
                    if (stats.isFile) return fs.realpath(withExt);
                }
            } catch (e) {
                // Continue trying other extensions
            }
        }

        return null;
    }

    /**
     * Try to resolve as a directory (look for package.json or index)
     */
    private tryResolveAsDirectory(dirpath: string): string | null {
        try {
            if (!fs.exists(dirpath)) return null;

            const stats = fs.stat(dirpath);
            if (!stats.isDirectory) return null;
        } catch (e) {
            return null;
        }

        // Try package.json
        const pkg = readPackageJson(dirpath);
        if (pkg) {
            // Try exports field first
            const exportsResolved = this.resolvePackageExports(pkg, dirpath);
            if (exportsResolved) {
                const resolved = this.tryResolveAsFile(exportsResolved);
                if (resolved) return resolved;
            }

            // Try main field
            if (pkg.main) {
                const mainPath = joinPaths(dirpath, pkg.main);
                const resolved = this.tryResolveAsFile(mainPath) ||
                    this.tryResolveAsDirectory(mainPath);
                if (resolved) return resolved;
            }
        }

        // Try index files
        const indexNames = ['index'];
        for (const name of indexNames) {
            const resolved = this.tryResolveAsFile(joinPaths(dirpath, name));
            if (resolved) return resolved;
        }

        return null;
    }

    /**
     * Resolve from node_modules
     */
    private resolveNodeModule(request: string, parentPath: string): string | null {
        const paths = this.getModulePaths(parentPath);

        for (const modulesPath of paths) {
            try {
                if (!fs.exists(modulesPath)) continue;

                const modulePath = joinPaths(modulesPath, request);
                const resolved = this.tryResolveAsFile(modulePath) ||
                    this.tryResolveAsDirectory(modulePath);
                if (resolved) return resolved;
            } catch (e) {
                // Continue to next path
            }
        }

        return null;
    }

    /**
     * Resolve module path with various strategies
     */
    private resolveModule(request: string, parentPath: string): string {
        this.log(`Resolving '${request}' from '${parentPath}'`);

        // Check for built-in modules
        if (this.builtinModules.has(request)) {
            throw new Error(
                `Cannot require built-in module '${request}'. ` +
                `Use import.meta.use() instead for circu.js modules.`
            );
        }

        // 1. Absolute path
        if (isAbsolutePath(request)) {
            const resolved = this.tryResolveAsFile(request) ||
                this.tryResolveAsDirectory(request);
            if (resolved) return resolved;
        }

        // 2. Relative path
        if (request.startsWith('./') || request.startsWith('../')) {
            const basePath = dirname(parentPath);
            const fullPath = resolvePath(basePath, request);
            const resolved = this.tryResolveAsFile(fullPath) ||
                this.tryResolveAsDirectory(fullPath);
            if (resolved) return resolved;
        }

        // 3. Node modules
        const resolved = this.resolveNodeModule(request, parentPath);
        if (resolved) return resolved;

        throw new Error(
            `Cannot find module '${request}'\n` +
            `Required from: ${parentPath}\n` +
            `Searched in: ${this.getModulePaths(parentPath).join(', ')}`
        );
    }

    /**
     * Load and compile a JavaScript module
     */
    private loadJavaScriptModule(module: Module): void {
        const filename = module.filename;

        // Read file
        const sourceBuffer = fs.readFile(filename);
        const source = engine.decodeString(sourceBuffer);
        const wrapped = [
            '/* Generated */ const { __filename, __dirname, require, module, exports } = globalThis.__cjs_module;',
            source,
        ].join('\n');

        // Compile and execute
        try {
            const dir = dirname(filename);

            // Execute the wrapper
            Reflect.set(globalThis, '__cjs_module', {
                __filename: filename,
                __dirname: dir,
                require: module.require,
                module: module,
                exports: module.exports
            });
            engine.eval(wrapped, filename, engine.EVAL_ASYNC | engine.EVAL_NEW_BACKTRACE);
            Reflect.deleteProperty(globalThis, '__cjs_module');

            module.loaded = true;
            this.log(`Loaded module: ${filename}`);
        } catch (error) {
            // Clean up on error
            this.cache.delete(filename);
            this.loading.delete(filename);
            throw new Error(`Error loading module '${filename}': ${error}`);
        }
    }

    /**
     * Load a JSON module
     */
    private loadJsonModule(module: Module): void {
        const filename = module.filename;

        const sourceBuffer = fs.readFile(filename);
        const source = engine.decodeString(sourceBuffer);

        try {
            module.exports = JSON.parse(source);
            module.loaded = true;
            this.log(`Loaded JSON module: ${filename}`);
        } catch (error) {
            this.cache.delete(filename);
            this.loading.delete(filename);
            throw new Error(`Failed to parse JSON in ${filename}: ${error}`);
        }
    }

    /**
     * Load a native module (.node)
     */
    private loadNativeModule(module: Module): void {
        throw new Error(
            `Native modules (.node) are not supported in this environment.\n` +
            `Module: ${module.filename}`
        );
    }

    /**
     * Load module based on file extension
     */
    private loadModule(module: Module): void {
        const ext = extname(module.filename);

        if (ext === '.json') {
            this.loadJsonModule(module);
        } else if (ext === '.node') {
            this.loadNativeModule(module);
        } else {
            // .js, .ts, .mjs, .cjs or no extension
            this.loadJavaScriptModule(module);
        }
    }

    /**
     * Create a require function for a specific module
     */
    private createRequire(parentPath: string, parentModule: Module): RequireFunction {
        const self = this;

        function require(request: string): any {
            // Resolve the module path
            const resolved = self.resolveModule(request, parentPath);

            // Check cache
            if (self.cache.has(resolved)) {
                const cachedModule = self.cache.get(resolved)!;
                self.log(`Using cached module: ${resolved}`);
                return cachedModule.exports;
            }

            // Check for circular dependency
            if (self.loading.has(resolved)) {
                self.log(`Circular dependency detected: ${resolved}`);
                // Return partial exports for circular dependencies
                const circularModule = self.cache.get(resolved);
                if (circularModule) {
                    return circularModule.exports;
                }
            }

            // Create new module
            const module = self.createModule(resolved, parentModule);

            // Cache immediately (before loading) to handle circular dependencies
            self.cache.set(resolved, module);
            self.loading.add(resolved);

            // Load the module
            try {
                self.loadModule(module);
            } catch (error) {
                // Remove from cache on error
                self.cache.delete(resolved);
                throw error;
            } finally {
                self.loading.delete(resolved);
            }

            return module.exports;
        }

        // Add require.resolve
        require.resolve = function (request: string, options?: ResolveOptions): string {
            const searchPaths = options?.paths || [parentPath];
            for (const searchPath of searchPaths) {
                try {
                    return self.resolveModule(request, searchPath);
                } catch (e) {
                    // Try next path
                }
            }
            throw new Error(`Cannot resolve module '${request}'`);
        };

        // Add require.cache
        require.cache = self.cache;

        // Add require.main
        require.main = self.mainModule;

        // Add require.extensions (for compatibility)
        require.extensions = {
            '.js': (module, filename) => self.loadJavaScriptModule(module),
            '.json': (module, filename) => self.loadJsonModule(module),
            '.node': (module, filename) => self.loadNativeModule(module)
        } satisfies Record<string, (module: Module, filename: string) => void>;

        return require;
    }

    /**
     * Execute a CommonJS module as the main entry point
     */
    public runMain(filename: string): any {
        const resolved = fs.realpath(filename);
        this.log(`Running main module: ${resolved}`);

        // Create main module
        this.mainModule = this.createModule(resolved, null);

        // Cache the main module
        this.cache.set(resolved, this.mainModule);
        this.loading.add(resolved);

        try {
            this.loadModule(this.mainModule);
        } finally {
            this.loading.delete(resolved);
        }

        return this.mainModule.exports;
    }

    /**
     * Create a require function for a specific context
     */
    public createRequireFunction(filename: string): RequireFunction {
        const resolved = resolvePath(filename);
        const module = this.createModule(resolved, null);
        return module.require;
    }

    /**
     * Install require globally
     */
    public installGlobal(mainFilename?: string): RequireFunction {
        const filename = mainFilename || joinPaths(os.cwd, 'index.js');
        const require = this.createRequireFunction(filename);
        Reflect.set(globalThis, 'require', require);
        this.log('Installed global require');
        return require;
    }

    /**
     * Clear module cache
     */
    public clearCache(): void {
        this.cache.clear();
        this.loading.clear();
        this.log('Cleared module cache');
    }

    /**
     * Get module cache
     */
    public getCache(): Map<string, Module> {
        return this.cache;
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a new module loader instance
 */
export function createLoader(options?: LoaderOptions): ModuleLoader {
    return new ModuleLoader(options);
}

/**
 * Create a require function for a specific file context
 */
export function createRequire(filename: string, options?: LoaderOptions): RequireFunction {
    const loader = new ModuleLoader(options);
    return loader.createRequireFunction(filename);
}

/**
 * Run a module as the main entry point
 */
export function runMain(filename: string, options?: LoaderOptions): any {
    const loader = new ModuleLoader(options);
    return loader.runMain(filename);
}

/**
 * Install require as a global function
 */
export function installGlobal(mainFilename?: string, options?: LoaderOptions): RequireFunction {
    const loader = new ModuleLoader(options);
    return loader.installGlobal(mainFilename);
}

// Default export
export default {
    createLoader,
    createRequire,
    runMain,
    installGlobal,
    ModuleLoader
};
