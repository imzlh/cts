// types.ts - Type Definitions

/**
 * Runtime configuration options
 */
export interface ConfigOptions {
    /** Cache directory for remote modules */
    cacheDir?: string;
    /** Enable HTTP module loading */
    enableHttp?: boolean;
    /** Enable JSR module loading */
    enableJsr?: boolean;
    /** Enable Node.js compatibility layer */
    enableNode?: boolean;
    /** Silent mode - suppress download logs */
    silent?: boolean;
    /** JSR cache TTL in milliseconds */
    jsrCacheTTL?: number;
    /** Memory limit in bytes */
    memoryLimit?: number;
    /** Max stack size in bytes */
    maxStackSize?: number;
    /** Path aliases from tsconfig.json/deno.json */
    pathAliases?: Record<string, string[]>;
    /** Base URL for path resolution */
    baseUrl?: string;
    /** Import map from deno.json */
    importMap?: Record<string, string>;
    /** polyfill path */
    polyfill?: string;
}

/**
 * Runtime configuration (resolved)
 */
export interface RuntimeConfig extends Required<Omit<ConfigOptions, 'pathAliases' | 'baseUrl' | 'importMap' | 'memoryLimit' | 'maxStackSize'>> {
    pathAliases?: Record<string, string[]>;
    baseUrl?: string;
    importMap?: Record<string, string>;
    memoryLimit?: number;
    maxStackSize?: number;
    _?: string;  // entry
    _args?: string[];  // entry args
    _offset: number;  // entry offset
}

/**
 * Module resolution cache entry
 */
export interface CacheEntry {
    resolved: string;
    timestamp: number;
}

/**
 * Package.json structure
 */
export interface PackageJson {
    name?: string;
    version?: string;
    main?: string;
    module?: string;
    exports?: string | Record<string, any>;
    type?: 'module' | 'commonjs';
}

/**
 * JSR package metadata
 */
export interface JsrPackageMeta {
    versions: Record<string, {
        yanked?: boolean;
    }>;
    latest?: string;
}

/**
 * JSR version metadata
 */
export interface JsrVersionMeta {
    manifest: Record<string, {
        size: number;
        checksum: string;
    }>;
    exports?: Record<string, string>;
}

/**
 * JSR cache metadata
 */
export interface JsrCacheMeta {
    latest: string;
    timestamp: number;
}

/**
 * Parsed JSR specifier
 */
export interface ParsedJsrSpecifier {
    scope: string;
    name: string;
    version: string | null;
    path: string;
}

/**
 * Parsed package name
 */
export interface ParsedPackageName {
    packageName: string;
    subpath: string;
}

/**
 * Node.js builtin resolver function
 */
export type NodeResolver = (name: string) => string | null;

/**
 * Module transformer function
 */
export type ModuleTransformer = (code: string, filename: string) => string;

/**
 * Supported file extensions
 */
export type FileExtension = '.ts' | '.tsx' | '.jsx' | '.js' | '.mjs' | '.cjs' | '.json';

/**
 * Import attributes (for future extensibility)
 */
export interface ImportAttributes {
    type?: 'json' | 'css' | 'wasm';
    [key: string]: unknown;
}

/**
 * Module load context
 */
export interface ModuleLoadContext {
    /** Resolved module path */
    resolvedPath: string;
    /** Parent module path */
    parentPath: string;
    /** Import attributes */
    attributes?: ImportAttributes;
    /** Whether this is the main module */
    isMain: boolean;
}

/**
 * Error message helper type
 */
export type ErrorMessage = string | Error | unknown;