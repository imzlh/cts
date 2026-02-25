/**
 * Package.json utilities shared between npm resolver and commonjs module system
 *
 * Features:
 * - Package.json parsing and caching
 * - ESM/CommonJS module type detection
 * - Package exports field resolution
 * - Main entry point resolution
 * - Subpath resolution
 *
 * @module package-utils
 */

import type { PackageJson } from './types';
import { dirname, extname, joinPaths, tryResolveFile } from './utils';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const console = import.meta.use('console');

// ============================================================================
// Type Definitions
// ============================================================================

interface PackageCacheEntry {
    pkg: PackageJson;
    lastChecked: number;
    pkgDir: string;
}

interface ResolveContext {
    pkgDir: string;
    pkgJson: PackageJson;
    forceCjs?: boolean;
    forceEsm?: boolean;
}

// ============================================================================
// Package Cache
// ============================================================================

class PackageCache {
    private cache = new Map<string, PackageCacheEntry>();
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    get(pkgPath: string): PackageJson | null {
        const entry = this.cache.get(pkgPath);
        if (!entry) return null;

        // Check if cache is still valid
        if (Date.now() - entry.lastChecked > this.CACHE_TTL) {
            this.cache.delete(pkgPath);
            return null;
        }

        return entry.pkg;
    }

    set(pkgPath: string, pkg: PackageJson, pkgDir: string): void {
        this.cache.set(pkgPath, {
            pkg,
            lastChecked: Date.now(),
            pkgDir
        });
    }

    has(pkgPath: string): boolean {
        return this.cache.has(pkgPath);
    }

    clear(): void {
        this.cache.clear();
    }

    delete(pkgPath: string): void {
        this.cache.delete(pkgPath);
    }
}

// Global package cache instance
const globalPackageCache = new PackageCache();

// ============================================================================
// Module Type Detection
// ============================================================================

/**
 * Determine if a file is an ESM module based on:
 * 1. File extension (.mjs = ESM, .cjs = CommonJS)
 * 2. Package.json type field for .js files (only for npm and local files)
 * 3. Protocol: non-npm protocols default to ESM
 * 4. Explicit type hint in import statement
 *
 * @param filepath - The file path to check
 * @param pkgDir - The directory containing the package.json (optional)
 * @param forceCjs - Force treat as CommonJS
 * @param forceEsm - Force treat as ESM
 * @param isNpmOrLocal - Whether this is from npm or local protocol (has package.json)
 * @returns true if the module is ESM, false if CommonJS
 */
export function isESMModule(
    filepath: string,
    pkgDir?: string,
    forceCjs?: boolean,
    forceEsm?: boolean,
    isNpmOrLocal?: boolean
): boolean {
    // Explicit type hints take precedence
    if (forceEsm) return true;
    if (forceCjs) return false;

    const ext = extname(filepath).toLowerCase();

    // .mjs is always ESM
    if (ext === '.mjs') return true;

    // .cjs is always CommonJS
    if (ext === '.cjs') return false;

    // For .js files from npm or local, check package.json type field
    if (ext === '.js' && isNpmOrLocal && pkgDir) {
        const pkgJson = readPackageJson(pkgDir);
        if (pkgJson?.type === 'module') return true;
        // Default to CommonJS for npm/local .js files without type="module"
        return false;
    }

    // For non-npm protocols (jsr, http, etc.), default to ESM
    // For other extensions, default to ESM
    return true;
}

/**
 * Determine if a file should be treated as CommonJS
 */
export function isCJSModule(
    filepath: string,
    pkgDir?: string,
    forceCjs?: boolean,
    forceEsm?: boolean,
    isNpmOrLocal?: boolean
): boolean {
    return !isESMModule(filepath, pkgDir, forceCjs, forceEsm, isNpmOrLocal);
}

// ============================================================================
// Package.json Reading and Parsing
// ============================================================================

/**
 * Read and parse package.json from a directory
 * Uses cache to avoid repeated file I/O
 *
 * @param dirpath - Directory containing package.json
 * @returns PackageJson object or null if not found
 */
export function readPackageJson(dirpath: string): PackageJson | null {
    const pkgPath = joinPaths(dirpath, 'package.json');

    // Check cache first
    const cached = globalPackageCache.get(pkgPath);
    if (cached) {
        return cached;
    }

    // Try to read from disk
    try {
        if (!fs.exists(pkgPath)) {
            return null;
        }

        const pkgData = fs.readFile(pkgPath);
        const pkgText = engine.decodeString(pkgData);
        const pkg = JSON.parse(pkgText) as PackageJson;

        // Cache the result
        globalPackageCache.set(pkgPath, pkg, dirpath);

        return pkg;
    } catch (e) {
        console.debug(`Failed to read package.json in ${dirpath}:`, e);
        return null;
    }
}

/**
 * Read package.json without using cache
 */
export function readPackageJsonNoCache(dirpath: string): PackageJson | null {
    const pkgPath = joinPaths(dirpath, 'package.json');

    try {
        if (!fs.exists(pkgPath)) {
            return null;
        }

        const pkgData = fs.readFile(pkgPath);
        const pkgText = engine.decodeString(pkgData);
        return JSON.parse(pkgText) as PackageJson;
    } catch (e) {
        console.debug(`Failed to read package.json in ${dirpath}:`, e);
        return null;
    }
}

// ============================================================================
// Package Exports Resolution
// ============================================================================

/**
 * Resolve package exports field
 * Supports:
 * - String exports: { "exports": "./index.js" }
 * - Object exports: { "exports": { ".": "./index.js", "./feature": "./feature.js" } }
 * - Conditional exports: { "exports": { ".": { "import": "./index.mjs", "require": "./index.cjs" } } }
 * - Pattern exports: { "exports": { "./features/*": "./features/*.js" } }
 *
 * @param context - Resolution context with package info
 * @param subpath - Subpath to resolve (default: '.')
 * @returns Resolved file path or null if not found
 */
export function resolvePackageExports(
    context: ResolveContext,
    subpath: string = '.'
): string | null {
    const { pkgJson, pkgDir } = context;
    const exports = pkgJson.exports;

    if (!exports) return null;

    // String exports: { "exports": "./index.js" }
    if (typeof exports === 'string') {
        if (subpath === '.' || subpath === './') {
            return resolveExportPath(context, exports);
        }
        return null;
    }

    if (typeof exports !== 'object') return null;

    // Direct match
    const directMatch = resolveExportTarget(context, exports[subpath]);
    if (directMatch) return directMatch;

    // Pattern matching with *
    for (const [key, value] of Object.entries(exports)) {
        if (!key.includes('*')) continue;

        const prefix = key.substring(0, key.indexOf('*'));
        const suffix = key.substring(key.indexOf('*') + 1);

        if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
            const replacement = subpath.slice(prefix.length, -suffix.length || undefined);
            const resolved = resolvePatternTarget(context, value, replacement);
            if (resolved) return resolved;
        }
    }

    return null;
}

/**
 * Resolve pattern target with * replacement
 */
function resolvePatternTarget(
    context: ResolveContext,
    target: any,
    replacement: string
): string | null {
    if (typeof target === 'string') {
        return resolveExportPath(context, target.replace('*', replacement));
    }

    if (typeof target === 'object' && target !== null) {
        // Try different condition keys in priority order
        const conditions = getConditionKeys(context);
        for (const condition of conditions) {
            if (typeof target[condition] === 'string') {
                const resolved = resolveExportPath(
                    context,
                    target[condition].replace('*', replacement)
                );
                if (resolved) return resolved;
            }
        }
    }

    return null;
}

/**
 * Resolve export target with conditional exports
 */
function resolveExportTarget(
    context: ResolveContext,
    target: any
): string | null {
    if (typeof target === 'string') {
        return resolveExportPath(context, target);
    }

    if (typeof target === 'object' && target !== null) {
        // Try different condition keys in priority order
        const conditions = getConditionKeys(context);
        for (const condition of conditions) {
            if (typeof target[condition] === 'string') {
                const resolved = resolveExportPath(context, target[condition]);
                if (resolved) return resolved;
            }
        }
    }

    return null;
}

/**
 * Get condition keys based on module type context
 */
function getConditionKeys(context: ResolveContext): string[] {
    const { forceCjs, forceEsm } = context;

    if (forceCjs) {
        return ['require', 'default'];
    }

    if (forceEsm) {
        return ['import', 'module', 'default'];
    }

    // Default: try all conditions in priority order
    return ['import', 'module', 'default', 'require'];
}

/**
 * Resolve export path to absolute file path
 */
function resolveExportPath(context: ResolveContext, path: string): string | null {
    if (!path) return null;

    // External URLs and protocols
    if (path.includes('://') || path.startsWith('npm:') || path.startsWith('jsr:')) {
        return path;
    }

    // Remove leading ./ if present
    const cleanPath = path.startsWith('./') ? path.substring(2) : path;
    const fullPath = joinPaths(context.pkgDir, cleanPath);

    try {
        return tryResolveFile(fullPath);
    } catch {
        return null;
    }
}

// ============================================================================
// Main Entry Point Resolution
// ============================================================================

/**
 * Resolve main entry point for a package
 * Checks in order:
 * 1. exports field (.)
 * 2. module field
 * 3. main field
 * 4. Default index files (index.js, index.mjs, index.cjs)
 *
 * @param context - Resolution context with package info
 * @returns Resolved file path or null if not found
 */
export function resolveMainEntry(context: ResolveContext): string | null {
    const { pkgJson, pkgDir } = context;

    // Try exports field first
    const exportsResult = resolvePackageExports(context, '.');
    if (exportsResult) return exportsResult;

    // Try module field (ESM)
    if (pkgJson.module) {
        const modulePath = joinPaths(pkgDir, pkgJson.module);
        try {
            return tryResolveFile(modulePath);
        } catch {}
    }

    // Try main field (CommonJS)
    if (pkgJson.main) {
        const mainPath = joinPaths(pkgDir, pkgJson.main);
        try {
            return tryResolveFile(mainPath);
        } catch {}
    }

    // Try default index files
    const defaultFiles = ['index.js', 'index.mjs', 'index.cjs'];
    for (const file of defaultFiles) {
        const path = joinPaths(pkgDir, file);
        if (fs.exists(path)) {
            return path;
        }
    }

    return null;
}

// ============================================================================
// Subpath Resolution
// ============================================================================

/**
 * Resolve a subpath within a package
 *
 * @param context - Resolution context with package info
 * @param subpath - Subpath to resolve (e.g., './feature' or 'feature')
 * @returns Resolved file path or null if not found
 */
export function resolveSubpath(context: ResolveContext, subpath: string): string | null {
    const { pkgDir } = context;

    // Handle empty or root subpath
    if (!subpath || subpath === '.' || subpath === './') {
        return resolveMainEntry(context);
    }

    // Normalize subpath to start with ./
    const normalizedSubpath = subpath.startsWith('./') ? subpath : `./${subpath}`;

    // Try exports field
    const exportsResult = resolvePackageExports(context, normalizedSubpath);
    if (exportsResult) return exportsResult;

    // Fall back to direct file resolution
    const cleanPath = normalizedSubpath.substring(2);
    const fullPath = joinPaths(pkgDir, cleanPath);

    try {
        return tryResolveFile(fullPath);
    } catch {
        return null;
    }
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Clear package.json cache
 */
export function clearPackageCache(): void {
    globalPackageCache.clear();
}

/**
 * Get package cache entries for debugging
 */
export function getPackageCacheEntries(): Map<string, PackageCacheEntry> {
    return (globalPackageCache as any).cache;
}

/**
 * Delete specific package from cache
 */
export function deletePackageCache(pkgPath: string): void {
    globalPackageCache.delete(pkgPath);
}

// ============================================================================
// Context Creation Helpers
// ============================================================================

/**
 * Create a resolution context from package directory
 */
export function createResolveContext(
    pkgDir: string,
    options: {
        forceCjs?: boolean;
        forceEsm?: boolean;
    } = {}
): ResolveContext | null {
    const pkgJson = readPackageJson(pkgDir);
    if (!pkgJson) return null;

    return {
        pkgDir,
        pkgJson,
        forceCjs: options.forceCjs,
        forceEsm: options.forceEsm
    };
}

// ============================================================================
// Exports
// ============================================================================

export default {
    isESMModule,
    isCJSModule,
    readPackageJson,
    readPackageJsonNoCache,
    resolvePackageExports,
    resolveMainEntry,
    resolveSubpath,
    clearPackageCache,
    getPackageCacheEntries,
    deletePackageCache,
    createResolveContext
};
