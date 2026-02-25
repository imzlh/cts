import type { RuntimeConfig, ParsedJsrSpecifier, JsrPackageMeta } from '../types';
import {
    errMsg,
    readTextFile,
    writeTextFile,
    joinPaths,
    dirname,
    ensureDir,
    isCacheExpired,
    normalizePath,
    fetchBinary,
    matchLatestVersion
} from '../utils';
import { BaseResolver, type ResolveResult, type LocalPathResult, ModuleType } from './base.js';
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const console = import.meta.use('console');

/**
 * JSR Module Resolver
 * Responsibility: Convert JSR protocol URLs to local file paths
 */
export class JsrResolver extends BaseResolver {
    private readonly jsrRegistry = 'https://jsr.io';
    private readonly urlMap = new Map<string, string>();

    constructor(private readonly config: RuntimeConfig) { 
        super();
    }

    readonly protocol = ['jsr'];

    /**
     * Main resolution entry point
     * Format: jsr:@scope/package[@version][/path]
     * JSR modules are always ESM
     */
    resolve(specifier: string, parent?: string, _attr?: Record<string, any>): ResolveResult {
        try {
            this.log(`Resolving: ${specifier}${parent ? ` (from ${parent})` : ''}`);
            
            // Handle relative imports within JSR modules
            if (this.isRelativePath(specifier) && parent?.startsWith('jsr:')) {
                const result = this.resolveRelativeImport(specifier, parent);
                return { path: result, isCjs: false };
            }
            
            // Parse and normalize specifier
            const parsed = this.parseSpecifier(specifier);
            if (!parsed.version) {
                parsed.version = this.getLatestVersion(parsed.scope, parsed.name);
                this.log(`Resolved latest version: ${parsed.version}`);
            } else {
                parsed.version = this.resolveVersion(parsed.scope, parsed.name, parsed.version);
            }

            // Resolve file path within package
            const filePath = this.resolveFilePath(parsed);
            
            // Download if needed
            const localPath = this.downloadFile(
                parsed.scope,
                parsed.name,
                parsed.version,
                filePath
            );

            // Track mapping
            const jsrUrl = `jsr:@${parsed.scope}/${parsed.name}@${parsed.version}/${filePath}`;
            this.urlMap.set(jsrUrl, localPath);
            
            this.log(`Resolved to: ${jsrUrl} -> ${localPath}`);
            // JSR modules are always ESM
            return { path: jsrUrl, isCjs: false };
        } catch (error) {
            this.log(`Failed to resolve ${specifier}: ${errMsg(error)}`);
            throw new Error(`JSR resolution failed for ${specifier}: ${errMsg(error)}`);
        }
    }

    /**
     * JSR modules are always ESM
     */

    getLocalPath(url: string): LocalPathResult {
        if (this.urlMap.has(url)) {
            return { path: this.urlMap.get(url)!, moduleType: ModuleType.ESM };
        }

        const parsed = this.parseSpecifier(url);
        if (!parsed.version) {
            throw new Error(`[JSR] Version required in protocol path: ${url}`);
        }

        const filePath = parsed.path.startsWith('/') ? parsed.path.substring(1) : parsed.path;
        const path = joinPaths(
            this.config.cacheDir,
            'jsr',
            parsed.scope,
            parsed.name,
            parsed.version,
            filePath
        );
          return { path, moduleType: ModuleType.ESM };
      }

    // ========== Private Helpers ==========

    private isRelativePath(path: string): boolean {
        return path.startsWith('./') || path.startsWith('../');
    }

    private resolveRelativeImport(specifier: string, parent: string): string {
        const parentParsed = this.parseSpecifier(parent);
        const parentDir = dirname(parentParsed.path || '');
        const resolvedPath = normalizePath(joinPaths(parentDir, specifier));
        
        this.log(`Relative path resolved: ${specifier} -> ${resolvedPath}`);
        
        // Re-parse with resolved path
        const newParsed = { ...parentParsed, path: resolvedPath };
        const filePath = this.resolveFilePath(newParsed);
        
        const localPath = this.downloadFile(
            newParsed.scope,
            newParsed.name,
            newParsed.version!,
            filePath
        );
        const jsrUrl = `jsr:@${newParsed.scope}/${newParsed.name}@${newParsed.version}/${filePath}`;
        this.urlMap.set(jsrUrl, localPath);
        this.log(`Mapped: ${jsrUrl} -> ${localPath}`);
        
        return jsrUrl;
    }

    private parseSpecifier(specifier: string): ParsedJsrSpecifier {
        // Remove 'jsr:' prefix and leading slashes
        let rest = specifier.substring(4);
        while (rest.startsWith('/')) rest = rest.substring(1);

        if (!rest.startsWith('@')) {
            throw new Error(`[JSR] Invalid specifier (must be @scope/name): ${specifier}`);
        }

        // Match: @scope/name[@version][/path]
        const match = rest.match(/^@([^\/]+)\/([^@\/]+)(?:@([^\/]+))?(\/.*)?$/);
        if (!match) {
            throw new Error(`[JSR] Invalid specifier format: ${rest}`);
        }

        const [, scope, name, version, path] = match;
        return {
            scope: scope!,
            name: name!,
            version: version || null,
            path: path || ''
        };
    }

    private resolveFilePath(parsed: ParsedJsrSpecifier): string {
        const versionMeta = this.getVersionMeta(parsed.scope, parsed.name, parsed.version!);

        // Default export
        if (!parsed.path || parsed.path === '/' || parsed.path === '.') {
            const defaultExport = versionMeta.exports?.['.'] || versionMeta.exports?.['./mod.ts'];
            if (!defaultExport) {
                throw new Error(`[JSR] No entry point found for @${parsed.scope}/${parsed.name}@${parsed.version}`);
            }
            return defaultExport.startsWith('./') ? defaultExport.substring(2) : defaultExport;
        }

        // Normalize path
        const normalized = normalizePath(parsed.path.startsWith('/') ? parsed.path : '/' + parsed.path);

        // Check exports map
        const exportPath = versionMeta.exports?.['.' + normalized];
        if (exportPath) {
            return exportPath.startsWith('./') ? exportPath.substring(2) : exportPath;
        }

        // Check manifest
        if (versionMeta.manifest[normalized]) {
            return normalized.startsWith('/') ? normalized.substring(1) : normalized;
        }

        // Try extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
        for (const ext of extensions) {
            const withExt = normalized + ext;
            if (versionMeta.manifest[withExt]) {
                return withExt.startsWith('/') ? withExt.substring(1) : withExt;
            }
        }

        // Try index files
        for (const ext of extensions) {
            const indexPath = `${normalized}/index${ext}`;
            if (versionMeta.manifest[indexPath]) {
                return indexPath.startsWith('/') ? indexPath.substring(1) : indexPath;
            }
        }

        throw new Error(
            `[JSR] File not found: ${parsed.path} in @${parsed.scope}/${parsed.name}@${parsed.version}`
        );
    }

    private getVersionMeta(scope: string, name: string, version: string) {
        const versionDir = joinPaths(this.config.cacheDir, 'jsr', scope, name, version);
        const metaFile = joinPaths(versionDir, 'meta.json');

        if (fs.exists(metaFile)) {
            try {
                const cached = JSON.parse(readTextFile(metaFile));
                if (cached._cachedAt && !isCacheExpired(cached._cachedAt, this.config.jsrCacheTTL)) {
                    return cached;
                }
                this.log(`Version meta cache expired for ${scope}/${name}@${version}`);
            } catch (error) {
                this.log(`Version meta cache broken for ${scope}/${name}@${version}: ${error}`);
            }
        }

        this.log(`Fetching version metadata: @${scope}/${name}@${version}`);
        const url = `${this.jsrRegistry}/@${scope}/${name}/${version}_meta.json`;
        const meta = this.fetchJsonInternal(url);

        ensureDir(versionDir);
        writeTextFile(metaFile, JSON.stringify({ ...meta, _cachedAt: Date.now() }, null, 2));

        return meta;
    }

    private getPackageMeta(scope: string, name: string): JsrPackageMeta {
        const cacheDir = joinPaths(this.config.cacheDir, 'jsr', scope, name);
        const metaFile = joinPaths(cacheDir, 'meta.json');

        // Return cached if valid
        if (fs.exists(metaFile)) {
            try {
                const cached = JSON.parse(readTextFile(metaFile));
                if (cached._cachedAt && !isCacheExpired(cached._cachedAt, this.config.jsrCacheTTL))
                    return cached;
                this.log(`Latest version cache expired for ${scope}/${name}`);
            } catch (error) {
                this.log(`Latest version cache broken for ${scope}/${name}: ${error}`);
            }
        }

        // Fetch from registry
        this.log(`Fetching package metadata: @${scope}/${name}`);
        const url = `${this.jsrRegistry}/@${scope}/${name}/meta.json`;
        const meta = this.fetchJsonInternal(url);

        if (!meta.latest) {
            throw new Error(`[JSR] No latest version for @${scope}/${name}`);
        }

        // Save cache
        ensureDir(cacheDir);
        writeTextFile(metaFile, JSON.stringify({ ...meta, _cachedAt: Date.now() }, null, 2));

        return meta;
    }

    private getLatestVersion(scope: string, name: string): string {
        const meta = this.getPackageMeta(scope, name);
        if (!meta.latest) {
            throw new Error(`[JSR] No latest version for @${scope}/${name}`);
        }
        return meta.latest;
    }

    private resolveVersion(scope: string, name: string, version: string): string {
        if (/^\d+\.\d+\.\d+/.test(version)) {
            return version;
        }
        
        if (/^[\^~><=]/.test(version)) {
            this.log(`Version range detected: ${version}, resolving to latest`);
            return this.getLatestVersion(scope, name);
        }

        const meta = this.getPackageMeta(scope, name);
        const v = matchLatestVersion(Object.keys(meta.versions), version);
        if (!v) {
            throw new Error(`[JSR] No matching version for ${version} in @${scope}/${name}`);
        }
        this.log(`Resolved version: ${version} -> ${v}`);
        return v;
    }

    private downloadFile(scope: string, name: string, version: string, filePath: string): string {
        const localPath = joinPaths(this.config.cacheDir, 'jsr', scope, name, version, filePath);

        if (fs.exists(localPath)) {
            return localPath;
        }

        this.log(`Downloading: @${scope}/${name}@${version}/${filePath}`);
        
        const urlPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
        const url = `${this.jsrRegistry}/@${scope}/${name}/${version}/${urlPath}`;
        const fileBytes = this.fetchBinaryInternal(url);

        ensureDir(dirname(localPath));
        fs.writeFile(localPath, new Uint8Array(fileBytes.buffer));

        return localPath;
    }

    private fetchJsonInternal(url: string): any {
        const bytes = this.fetchBinaryInternal(url);
        const text = engine.decodeString(bytes);
        
        // Check for HTML error page
        if (text.trim().startsWith('<')) {
            throw new Error(`[JSR] Registry returned HTML instead of JSON: ${url}`);
        }

        return JSON.parse(text);
    }

    private fetchBinaryInternal(url: string): Uint8Array<ArrayBuffer> {
        const bytes = fetchBinary(url);
        if (!bytes || bytes.length === 0) {
            throw new Error(`[JSR] Failed to fetch: ${url}`);
        }
        return bytes;
    }

    private log(message: string): void {
        console.debug(`[JSR] ${message}`);
    }
}