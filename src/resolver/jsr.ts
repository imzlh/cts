import type {
    RuntimeConfig,
    ParsedJsrSpecifier,
    JsrPackageMeta,
    JsrVersionMeta
} from '../types.ts';
import {
    errMsg,
    readTextFile,
    writeTextFile,
    joinPaths,
    dirname,
    ensureDir,
    tryResolveFile,
    isCacheExpired,
    matchLatestVersion,
    normalizePath
} from '../utils';
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const xhr = import.meta.use('xhr');
const console = import.meta.use('console');

/**
 * JSR Module Resolver
 */
export class JsrResolver {
    private readonly jsrRegistry = 'https://jsr.io';
    private readonly urlMap = new Map<string, string>();

    constructor(private readonly config: RuntimeConfig) { }

    /**
     * Resolve JSR module
     * Format: jsr:@scope/package[@version][/path]
     */
    resolve(specifier: string, parent: string): string {
        try {
            const parsed = this.parseSpecifier(specifier);
            const version = this.resolveVersion(parsed.scope, parsed.name, parsed.version);
            const versionMeta = this.getVersionMeta(parsed.scope, parsed.name, version);

            // resolve file path
            const resolvedPath = this.resolveFile(
                parsed.scope,
                parsed.name,
                version,
                parsed.path,
                versionMeta
            );
            const abspath = this.downloadFile(parsed.scope, parsed.name, version, resolvedPath);

            // Track URL mapping
            let endPath = normalizePath(resolvedPath);
            if (endPath[0] == '/') endPath = endPath.substring(1);
            const jsrUrl = `jsr:@${parsed.scope}/${parsed.name}@${version}/${endPath}`;
            this.urlMap.set(jsrUrl, abspath);

            return jsrUrl;
        } catch (error) {
            throw new Error(`Failed to resolve JSR module ${specifier}: ${errMsg(error)}`);
        }
    }

    /**
     * Resolve relative import within JSR package
     */
    resolveRelative(relativePath: string, parentPath: string): string {
        const parentDir = dirname(parentPath);
        const resolvedPath = normalizePath(joinPaths(parentDir, relativePath));
        return resolvedPath;
    }


    /**
     * download file from JSR registry
     */
    private downloadFile(scope: string, name: string, version: string, filePath: string, refresh = false) {
        const localPath = joinPaths(this.config.cacheDir, 'jsr', scope, name, version, filePath);

        if (!refresh && fs.exists(localPath)) {
            return localPath; // not required to download again
        }

        this.logDownload(`Downloading @${scope}/${name}@${version}/${filePath}`);
        const fileUrl = `${this.jsrRegistry}/@${scope}/${name}/${version}/${filePath}`;
        const fileContent = this.fetchSync(fileUrl);

        ensureDir(dirname(localPath));
        const encoded = engine.encodeString(fileContent);
        fs.writeFile(localPath, encoded.buffer);

        return localPath;
    }

    /**
     * get realpath of file
     */
    getLocalPath(protocolPath: string): string {
        if (this.urlMap.has(protocolPath))
            return this.urlMap.get(protocolPath)!;

        const parsed = this.parseSpecifier(protocolPath);

        if (!parsed.version) {
            throw new Error(`Version required in protocol path: ${protocolPath}`);
        }

        const filePath = parsed.path.startsWith('/') ? parsed.path.substring(1) : parsed.path;

        // ensure file is downloaded
        this.downloadFile(parsed.scope, parsed.name, parsed.version, filePath);

        // build path
        return joinPaths(
            this.config.cacheDir,
            'jsr',
            parsed.scope,
            parsed.name,
            parsed.version,
            filePath
        );
    }

    /**
     * Check if path is a cached JSR module
     */
    isCachedModule(path: string): boolean {
        // Check if path is in JSR cache directory
        const jsrCacheDir = joinPaths(this.config.cacheDir, 'jsr');
        return path.startsWith(jsrCacheDir);
    }

    /**
     * Parse JSR specifier
     */
    private parseSpecifier(specifier: string): ParsedJsrSpecifier {
        let rest = specifier.substring(4); // Remove 'jsr:' prefix

        if (!rest.startsWith('@')) {
            throw new Error(`Invalid JSR specifier: ${specifier} (must start with @scope/name)`);
        }

        const match = rest.match(/^@([^\/]+)\/([^@\/]+)(?:@([^\/]+))?(\/.*)?$/);
        if (!match) {
            throw new Error(`Invalid JSR specifier format: ${specifier}`);
        }

        const [, scope, name, version, path] = match;

        return {
            scope: scope!,
            name: name!,
            version: version || null,
            path: path || ''
        };
    }

    /**
     * parse version
     */
    private resolveVersion(scope: string, name: string, versionRange: string | null): string {
        const packageMeta = this.getPackageMeta(scope, name);

        // if no version specified, use latest
        if (!versionRange) {
            if (!packageMeta.latest) {
                throw new Error(`No latest version found for @${scope}/${name}`);
            }
            this.logDownload(`Using latest version: @${scope}/${name}@${packageMeta.latest}`);
            return packageMeta.latest;
        }

        // get all available versions (excluding yanked)
        const availableVersions = Object.entries(packageMeta.versions)
            .filter(([_, meta]) => !meta.yanked)
            .map(([version]) => version);

        if (availableVersions.length === 0) {
            throw new Error(`No available versions for @${scope}/${name}`);
        }

        // match version
        const matchedVersion = matchLatestVersion(availableVersions, versionRange);

        if (!matchedVersion) {
            throw new Error(
                `No version of @${scope}/${name} satisfies ${versionRange}. ` +
                `Available versions: ${availableVersions.join(', ')}`
            );
        }

        return matchedVersion;
    }

    /**
     * get package meta data
     */
    private getPackageMeta(scope: string, name: string): JsrPackageMeta {
        const cacheDir = joinPaths(this.config.cacheDir, 'jsr', scope, name);
        const metaFile = joinPaths(cacheDir, 'meta.json');

        // check cache
        if (fs.exists(metaFile)) {
            try {
                const cached = JSON.parse(readTextFile(metaFile));
                // check cache expiration
                if (cached._cachedAt && !isCacheExpired(cached._cachedAt, this.config.jsrCacheTTL)) {
                    return cached;
                }
            } catch {
                // cache is broken, re-fetch
            }
        }

        // get meta data from JSR registry
        const metaUrl = `${this.jsrRegistry}/@${scope}/${name}/meta.json`;
        const metaJson = this.fetchSync(metaUrl);
        const meta: JsrPackageMeta = JSON.parse(metaJson);

        // save to cache
        ensureDir(cacheDir);
        const cachedMeta = {
            ...meta,
            _cachedAt: Date.now()
        };
        writeTextFile(metaFile, JSON.stringify(cachedMeta, null, 2));

        return meta;
    }

    /**
     * get version meta data
     */
    private getVersionMeta(scope: string, name: string, version: string): JsrVersionMeta {
        const versionDir = joinPaths(this.config.cacheDir, 'jsr', scope, name, version);
        const metaFile = joinPaths(versionDir, 'meta.json');

        // check cache
        if (fs.exists(metaFile)) {
            try {
                return JSON.parse(readTextFile(metaFile));
            } catch {
                // cache is broken, re-fetch
            }
        }

        // get meta data from JSR registry
        this.logDownload(`Fetching metadata for @${scope}/${name}@${version}`);
        const versionUrl = `${this.jsrRegistry}/@${scope}/${name}/${version}_meta.json`;
        const versionJson = this.fetchSync(versionUrl);
        const versionMeta: JsrVersionMeta = JSON.parse(versionJson);

        // save to cache
        ensureDir(versionDir);
        writeTextFile(metaFile, versionJson);

        return versionMeta;
    }

    /**
     * resolve jsr file path
     * warn: it returns a relative path to package root
     */
    private resolveFile(
        scope: string,
        name: string,
        version: string,
        path: string,
        versionMeta: JsrVersionMeta
    ): string {
        // use default exports(`.`)
        if (!path || path === '/' || path === '.') {
            if (versionMeta.exports) {
                const defaultExport = versionMeta.exports['.'] || versionMeta.exports['./mod.ts'];
                if (defaultExport) {
                    const exportPath = defaultExport.startsWith('./')
                        ? defaultExport.substring(2)
                        : defaultExport;

                    return exportPath
                }
            }

            throw new Error(`No entry point found for @${scope}/${name}@${version}`);
        }

        // parse path
        // note: mainfest paths are always absolute to package root
        const normalizedPath = normalizePath(path.startsWith('/') ? path : '/' + path);

        // match exports
        // however, it starts with `.` instead of `/`
        const exportsKey = '.' + normalizedPath;
        if (versionMeta.exports?.[exportsKey]) {
            return normalizePath(versionMeta.exports[exportsKey]);
        }

        // match manifest
        if (versionMeta.manifest[normalizedPath]) {
            return normalizedPath;
        }

        // try adding extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
        for (const ext of extensions) {
            const pathWithExt = normalizedPath + ext;
            if (versionMeta.manifest[pathWithExt]) {
                return pathWithExt;
            }
        }

        // try index file
        for (const ext of extensions) {
            const indexPath = `${normalizedPath}/index${ext}`;
            if (versionMeta.manifest[indexPath]) {
                return indexPath;
            }
        }

        // not found
        throw new Error(`Cannot find ${path} in @${scope}/${name}@${version}`);
    }

    /**
     * Fetch synchronously
     */
    private fetchSync(url: string): string {
        try {
            const request = new xhr.XMLHttpRequest();
            request.open('GET', url, false);
            request.send();

            if (request.status !== 200) {
                throw new Error(`HTTP ${request.status}: ${request.statusText}`);
            }

            return request.responseText;
        } catch (error) {
            throw new Error(`Failed to fetch ${url}: ${errMsg(error)}`);
        }
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