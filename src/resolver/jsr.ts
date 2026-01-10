// resolver/jsr.ts - JSR Protocol Resolver

import type {
    RuntimeConfig,
    ParsedJsrSpecifier
} from '../types.ts';
import {
    errMsg,
    readTextFile,
    writeTextFile,
    joinPaths,
    dirname,
    ensureDir,
    isCacheExpired,
    normalizePath,
    fetchSync,
    fetchBinary
} from '../utils';
import { BaseResolver } from './base.js';
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
    private readonly verbose: boolean;

    constructor(private readonly config: RuntimeConfig) { 
        super();
        this.verbose = config.verbose || false;
    }

    readonly protocol = ['jsr'];

    /**
     * Log debug information if verbose is enabled
     */
    private debugLog(message: string, ...args: any[]): void {
        if (this.verbose) {
            console.log(`[JSR:DEBUG] ${message}`, ...args);
        }
    }

    /**
     * Check if a path is a relative path
     */
    private isRelativePath(path: string): boolean {
        return path.startsWith('./') || path.startsWith('../');
    }

    /**
     * Resolve JSR module and return local path
     * Format: jsr:@scope/package[@version][/path]
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): string {
        try {
            this.debugLog('Resolving JSR module', { specifier, parent });
            
            // Handle relative imports within JSR modules
            if (this.isRelativePath(specifier) && parent && parent.startsWith('jsr:')) {
                this.debugLog('Resolving relative import within JSR module', { specifier, parent });
                
                const parentParsed = this.parseSpecifier(parent);
                this.debugLog('Parsed parent JSR specifier', parentParsed);
                
                // Resolve relative path against parent path
                const parentDir = dirname(parentParsed.path || '');
                const resolvedPath = normalizePath(joinPaths(parentDir, specifier));
                
                this.debugLog('Resolved relative path', { parentDir, specifier, resolvedPath });
                
                // Update the path in the parsed specifier
                const newParsed = {
                    ...parentParsed,
                    path: resolvedPath
                };
                
                // Resolve file path
                this.debugLog('Resolving file path', { 
                    scope: newParsed.scope, 
                    name: newParsed.name, 
                    version: newParsed.version, 
                    path: newParsed.path 
                });
                const filePath = this.resolveFile(
                    newParsed.scope,
                    newParsed.name,
                    newParsed.version!,
                    newParsed.path
                );
                this.debugLog('Resolved file path', filePath);

                // Download file if not cached
                this.debugLog('Downloading file if needed', filePath);
                const localPath = this.downloadFile(
                    newParsed.scope,
                    newParsed.name,
                    newParsed.version!,
                    filePath
                );
                this.debugLog('File local path', localPath);

                // Track URL mapping
                const jsrUrl = `jsr:@${newParsed.scope}/${newParsed.name}@${newParsed.version}/${filePath}`;
                this.urlMap.set(jsrUrl, localPath);
                this.debugLog('URL mapping added', { jsrUrl, localPath });

                return jsrUrl;
            }
            
            const parsed = this.parseSpecifier(specifier);
            this.debugLog('Parsed JSR specifier', parsed);
            
            // If no version specified, use latest
            if (!parsed.version) {
                this.debugLog('No version specified, fetching latest version');
                const latestVersion = this.getLatestVersion(parsed.scope, parsed.name);
                parsed.version = latestVersion;
                this.debugLog('Using latest version', latestVersion);
            }

            // Resolve file path
            this.debugLog('Resolving file path', { 
                scope: parsed.scope, 
                name: parsed.name, 
                version: parsed.version, 
                path: parsed.path 
            });
            const resolvedPath = this.resolveFile(
                parsed.scope,
                parsed.name,
                parsed.version,
                parsed.path
            );
            this.debugLog('Resolved file path', resolvedPath);

            // Download file if not cached
            this.debugLog('Downloading file if needed', resolvedPath);
            const localPath = this.downloadFile(
                parsed.scope,
                parsed.name,
                parsed.version,
                resolvedPath
            );
            this.debugLog('File local path', localPath);

            // Track URL mapping
            const jsrUrl = `jsr:@${parsed.scope}/${parsed.name}@${parsed.version}/${resolvedPath}`;
            this.urlMap.set(jsrUrl, localPath);
            this.debugLog('URL mapping added', { jsrUrl, localPath });

            return jsrUrl;
        } catch (error) {
            this.debugLog('Error resolving JSR module', error);
            throw new Error(`Failed to resolve JSR module ${specifier}: ${errMsg(error)}`);
        }
    }

    /**
     * Get local path for JSR module
     */
    getLocalPath(url: string): string {
        this.debugLog('Getting local path for URL', url);
        
        if (this.urlMap.has(url)) {
            const localPath = this.urlMap.get(url)!;
            this.debugLog('Found URL mapping', { url, localPath });
            return localPath;
        }

        const parsed = this.parseSpecifier(url);
        this.debugLog('Parsed URL for local path', parsed);

        if (!parsed.version) {
            throw new Error(`Version required in protocol path: ${url}`);
        }

        // Ensure filePath doesn't start with a slash
        const filePath = parsed.path.startsWith('/') ? parsed.path.substring(1) : parsed.path;

        // Build local path
        const localPath = joinPaths(
            this.config.cacheDir,
            'jsr',
            parsed.scope,
            parsed.name,
            parsed.version,
            filePath
        );
        
        this.debugLog('Constructed local path', { url, localPath });
        return localPath;
    }

    /**
     * Parse JSR specifier
     */
    private parseSpecifier(specifier: string): ParsedJsrSpecifier {
        this.debugLog('Parsing JSR specifier', specifier);
        
        // Remove 'jsr:' prefix and any leading slashes
        let rest = specifier.substring(4); // Remove 'jsr:' prefix
        while (rest.startsWith('/')) {
            rest = rest.substring(1);
        }

        if (!rest.startsWith('@')) {
            throw new Error(`Invalid JSR specifier: ${specifier} (must start with @scope/name)`);
        }

        const match = rest.match(/^@([^\/]+)\/([^@\/]+)(?:@([^\/]+))?(\/.*)?$/);
        if (!match) {
            throw new Error(`Invalid JSR specifier format: ${specifier}`);
        }

        const [, scope, name, version, path] = match;

        const result = {
            scope: scope!,
            name: name!,
            version: version || null,
            path: path || ''
        };
        
        this.debugLog('Parsed JSR specifier result', result);
        return result;
    }

    /**
     * Get latest version of a package
     */
    private getLatestVersion(scope: string, name: string): string {
        this.debugLog('Getting latest version', { scope, name });
        
        const cacheDir = joinPaths(this.config.cacheDir, 'jsr', scope, name);
        const metaFile = joinPaths(cacheDir, 'meta.json');

        // Check cache
        if (fs.exists(metaFile)) {
            this.debugLog('Found cached meta file', metaFile);
            try {
                const cached = JSON.parse(readTextFile(metaFile));
                // Check cache expiration
                if (cached._cachedAt && !isCacheExpired(cached._cachedAt, this.config.jsrCacheTTL)) {
                    if (cached.latest) {
                        this.debugLog('Using cached latest version', cached.latest);
                        return cached.latest;
                    }
                }
                this.debugLog('Cache expired or invalid, will refetch');
            } catch {
                // Cache is broken, re-fetch
                this.debugLog('Cache is broken, will refetch');
            }
        } else {
            this.debugLog('No cached meta file found');
        }

        // Fetch metadata from JSR registry
        this.logDownload(`Fetching metadata for @${scope}/${name}`);
        const metaUrl = `${this.jsrRegistry}/@${scope}/${name}/meta.json`;
        this.debugLog('Fetching metadata from JSR registry', metaUrl);
        
        const metaBytes = fetchBinary(metaUrl);
        const metaJson = engine.decodeString(metaBytes);
        
        // Check if response is HTML (error page) instead of JSON
        if (metaJson.trim().startsWith('<')) {
            console.debug('[JSR:DEBUG] Received HTML instead of JSON for package metadata');
            throw new Error(`Server returned HTML instead of JSON for package metadata: ${metaUrl}`);
        }
        
        const meta = JSON.parse(metaJson);
        this.debugLog('Received package metadata', meta);

        // Save to cache
        ensureDir(cacheDir);
        const cachedMeta = {
            ...meta,
            _cachedAt: Date.now()
        };
        writeTextFile(metaFile, JSON.stringify(cachedMeta, null, 2));
        this.debugLog('Saved metadata to cache', metaFile);

        if (!meta.latest) {
            throw new Error(`No latest version found for @${scope}/${name}`);
        }

        this.debugLog('Latest version from metadata', meta.latest);
        return meta.latest;
    }

    /**
     * Resolve file path within JSR package
     */
    private resolveFile(
        scope: string,
        name: string,
        version: string,
        path: string
    ): string {
        this.debugLog('Resolving file path', { scope, name, version, path });
        
        // Get version metadata
        const versionMeta = this.getVersionMeta(scope, name, version);
        this.debugLog('Got version metadata', versionMeta);

        // Use default exports ('.')
        if (!path || path === '/' || path === '.') {
            this.debugLog('Resolving default export');
            if (versionMeta.exports) {
                const defaultExport = versionMeta.exports['.'] || versionMeta.exports['./mod.ts'];
                if (defaultExport) {
                    const exportPath = defaultExport.startsWith('./')
                        ? defaultExport.substring(2)
                        : defaultExport;
                    this.debugLog('Resolved default export path', exportPath);
                    return exportPath;
                }
            }
            throw new Error(`No entry point found for @${scope}/${name}@${version}`);
        }

        // Normalize path
        const normalizedPath = normalizePath(path.startsWith('/') ? path : '/' + path);
        this.debugLog('Normalized path', normalizedPath);

        // Match exports
        const exportsKey = '.' + normalizedPath;
        this.debugLog('Checking exports key', exportsKey);
        
        if (versionMeta.exports?.[exportsKey]) {
            const exportPath = versionMeta.exports[exportsKey];
            const result = exportPath.startsWith('./') ? exportPath.substring(2) : exportPath;
            this.debugLog('Found export in exports map', { exportsKey, exportPath, result });
            return result;
        }

        // Match manifest
        if (versionMeta.manifest[normalizedPath]) {
            const result = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
            this.debugLog('Found path in manifest', { normalizedPath, result });
            return result;
        }

        // Try adding extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
        this.debugLog('Trying extensions', extensions);
        
        for (const ext of extensions) {
            const pathWithExt = normalizedPath + ext;
            if (versionMeta.manifest[pathWithExt]) {
                const result = pathWithExt.startsWith('/') ? pathWithExt.substring(1) : pathWithExt;
                this.debugLog('Found path with extension in manifest', { pathWithExt, result });
                return result;
            }
        }

        // Try index file
        this.debugLog('Trying index files');
        for (const ext of extensions) {
            const indexPath = `${normalizedPath}/index${ext}`;
            if (versionMeta.manifest[indexPath]) {
                const result = indexPath.startsWith('/') ? indexPath.substring(1) : indexPath;
                this.debugLog('Found index file in manifest', { indexPath, result });
                return result;
            }
        }

        // Not found
        this.debugLog('File not found in package', { 
            path, 
            normalizedPath, 
            exportsKey, 
            availableExports: Object.keys(versionMeta.exports || {}),
            availableManifest: Object.keys(versionMeta.manifest || {})
        });
        throw new Error(`Cannot find ${path} in @${scope}/${name}@${version}`);
    }

    /**
     * Get version metadata
     */
    private getVersionMeta(scope: string, name: string, version: string) {
        this.debugLog('Getting version metadata', { scope, name, version });
        
        // Resolve version range to actual version
        const resolvedVersion = this.resolveVersion(scope, name, version);
        this.debugLog('Resolved version', { version, resolvedVersion });
        
        const versionDir = joinPaths(this.config.cacheDir, 'jsr', scope, name, resolvedVersion);
        const metaFile = joinPaths(versionDir, 'meta.json');

        // Check cache
        if (fs.exists(metaFile)) {
            this.debugLog('Found cached version meta file', metaFile);
            try {
                const cached = JSON.parse(readTextFile(metaFile));
                // Check cache expiration
                if (cached._cachedAt && !isCacheExpired(cached._cachedAt, this.config.jsrCacheTTL)) {
                    this.debugLog('Using cached version metadata');
                    return cached;
                }
                this.debugLog('Version metadata cache expired, will refetch');
            } catch {
                // Cache is broken, re-fetch
                this.debugLog('Version metadata cache is broken, will refetch');
            }
        } else {
            this.debugLog('No cached version meta file found');
        }

        // Fetch metadata from JSR registry
        this.logDownload(`Fetching metadata for @${scope}/${name}@${resolvedVersion}`);
        const versionUrl = `${this.jsrRegistry}/@${scope}/${name}/${resolvedVersion}_meta.json`;
        this.debugLog('Fetching version metadata from JSR registry', versionUrl);
        
        const versionBytes = fetchBinary(versionUrl);
        const versionJson = engine.decodeString(versionBytes);
        
        // Check if response is HTML (error page) instead of JSON
        if (versionJson.trim().startsWith('<')) {
            console.debug('[JSR:DEBUG] Received HTML instead of JSON for version metadata');
            throw new Error(`Server returned HTML instead of JSON for version metadata: ${versionUrl}`);
        }
        
        const versionMeta = JSON.parse(versionJson);
        this.debugLog('Received version metadata', versionMeta);

        // Save to cache
        ensureDir(versionDir);
        const cachedVersionMeta = {
            ...versionMeta,
            _cachedAt: Date.now()
        };
        writeTextFile(metaFile, JSON.stringify(cachedVersionMeta, null, 2));
        this.debugLog('Saved version metadata to cache', metaFile);

        return versionMeta;
    }

    /**
     * Download file from JSR registry
     */
    private downloadFile(scope: string, name: string, version: string, filePath: string) {
        this.debugLog('Downloading file', { scope, name, version, filePath });
        
        // Resolve version range to actual version
        const resolvedVersion = this.resolveVersion(scope, name, version);
        this.debugLog('Resolved version', { version, resolvedVersion });
        
        const localPath = joinPaths(this.config.cacheDir, 'jsr', scope, name, resolvedVersion, filePath);

        if (fs.exists(localPath)) {
            this.debugLog('File already exists locally', localPath);
            return localPath; // Already cached
        }

        this.logDownload(`Downloading @${scope}/${name}@${resolvedVersion}/${filePath}`);
        
        // Ensure filePath doesn't start with a slash for the URL
        const urlPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
        const fileUrl = `${this.jsrRegistry}/@${scope}/${name}/${resolvedVersion}/${urlPath}`;
        this.debugLog('Fetching file from JSR registry', fileUrl);
        
        const fileBytes = fetchBinary(fileUrl);
        
        // Check if response is HTML (error page) instead of file content
        // Only decode as string for the check, but keep original bytes for writing
        const fileContent = engine.decodeString(fileBytes);
        if (fileContent.trim().startsWith('<')) {
            console.debug('[JSR:DEBUG] Received HTML instead of file content');
            throw new Error(`Server returned HTML instead of file content: ${fileUrl}`);
        }
        
        this.debugLog('Received file content', { size: fileBytes.length });

        ensureDir(dirname(localPath));
        fs.writeFile(localPath, fileBytes.buffer);
        this.debugLog('Saved file to local path', localPath);

        return localPath;
    }

    /**
     * Resolve version range to actual version
     */
    private resolveVersion(scope: string, name: string, version: string): string {
        this.debugLog('Resolving version', { scope, name, version });
        
        // Handle version ranges (e.g., ^1.0.0, ~1.0.0)
        if (version.startsWith('^') || version.startsWith('~') || version.startsWith('>=') || version.startsWith('<=') || version.startsWith('>')) {
            this.debugLog('Version range detected, fetching latest version', version);
            return this.getLatestVersion(scope, name);
        }
        
        // For exact versions, return as is
        return version;
    }

    /**
     * Log download
     */
    private logDownload(message: string): void {
        if (!this.config.silent) {
            console.log(`📦 ${message}`);
        }
    }
}