// resolvers/npm.ts - NPM Package Resolver with Auto-Download

import type { RuntimeConfig, PackageJson, ParsedPackageName } from '../types';
import {
    readTextFile,
    writeTextFile,
    joinPaths,
    dirname,
    tryResolveFile,
    ensureDir,
    errMsg,
    matchLatestVersion,
    unTarGz,
    normalizePath,
    fetchSync,
    fetchBinary
} from '../utils';
import { BaseResolver } from './base.js';

const fs = import.meta.use('fs');
const sys = import.meta.use('sys');
const xhr = import.meta.use('xhr');
const console = import.meta.use('console');
const os = import.meta.use('os');

/**
 * NPM Registry
 */
interface NpmConfig {
    registry: string;
}

/**
 * NPM Package Metadata
 */
interface NpmPackageMetadata {
    name: string;
    versions: Record<string, {
        version: string;
        dist: {
            tarball: string;
            shasum?: string;
        };
    }>;
    'dist-tags': {
        latest: string;
        [tag: string]: string;
    };
}

/**
 * NPM Package Resolver with Auto-Download
 */
export class NpmResolver extends BaseResolver {
    private readonly globalCacheDir: string;
    private npmConfig: NpmConfig | null = null;

    readonly protocol = ['npm'];

    constructor(private readonly config: RuntimeConfig) {
        super();
        this.globalCacheDir = joinPaths(this.config.cacheDir, 'npm');
    }

    /**
     * Clean npm specifier by removing protocol prefix and handling extra slashes
     */
    private cleanNpmSpecifier(specifier: string): string {
        // Remove npm: protocol prefix if present
        let packageName = specifier.startsWith('npm:') ? specifier.substring(4) : specifier;
        
        // Handle case where there's an extra slash after npm: (e.g., npm:/preact@^10.27.2/jsx-runtime)
        if (packageName.startsWith('/')) {
            packageName = packageName.substring(1);
        }
        
        return packageName;
    }

    /**
     * Resolve npm package import
     */
    resolve(specifier: string, parent?: string, attr?: Record<string, any>): string {
        const packageName = this.cleanNpmSpecifier(specifier);
        const { packageName: pkgName, subpath } = this.parsePackageName(packageName);

        let packageDir = this.findPackageDir(pkgName, parent || '');
        if (!packageDir) {
            packageDir = this.autoInstallPackage(pkgName);
        }

        if (!packageDir) {
            throw new Error(`Package "${pkgName}" not found and auto-install failed`);
        }

        // Resolve exports
        if (subpath) {
            const exported = this.resolvePackageExports(packageDir, subpath);
            if (exported) {
                return exported;
            }

            // Ensure subpath doesn't start with './' to avoid double slashes
            const cleanSubpath = subpath.startsWith('./') ? subpath.substring(2) : subpath;
            const subpathFull = joinPaths(packageDir, cleanSubpath);
            return tryResolveFile(subpathFull);
        }

        // Main entry
        return this.resolvePackageMain(packageDir);
    }

    getLocalPath(url: string): string {
        return url; // npm package use full local path
    }

    /**
     * Auto install package to global scope(unstable)
     */
    private autoInstallPackage(packageName: string): string | null {
        try {
            if (!this.config.silent) {
                console.log(`📦 npx ${packageName}`);
            }

            const config = this.getNpmConfig();
            const metadata = this.fetchPackageMetadata(packageName, config.registry);

            // Extract version from original package name if present
            const versionMatch = packageName.match(/@[\^~]?\d+\.\d+\.\d+$/);
            let version = versionMatch ? versionMatch[0].substring(1) : null;
            
            // If no version specified, use latest
            if (!version) {
                version = metadata['dist-tags'].latest;
                if (!version) {
                    throw new Error(`No latest version found for ${packageName}`);
                }
            }

            const versionData = metadata.versions[version];
            if (!versionData) {
                throw new Error(`Version ${version} not found in metadata`);
            }

            // download tarball
            const tarballUrl = versionData.dist.tarball;
            const packageDir = joinPaths(this.globalCacheDir, packageName);

            if (!this.config.silent) {
                console.debug(`[NPM] Downloading ${packageName}@${version}...`);
            }

            const tarballData = this.downloadTarball(tarballUrl);

            if (!this.config.silent) {
                console.debug(`[NPM] Extracting...`);
            }

            // unextract using zlib
            const files = unTarGz(tarballData);
            ensureDir(packageDir);
            for (const file of files) {
                // remove package/ prefix
                let filePath = normalizePath(file.path);
                if (filePath.startsWith('package/'))
                    filePath = filePath.substring(8);
                const targetPath = joinPaths(packageDir, filePath);
                
                if (file.type == 'dir') {
                    ensureDir(targetPath);
                } else {
                    // Ensure parent directory exists before writing file
                    const parentDir = dirname(targetPath);
                    if (!fs.exists(parentDir)) {
                        ensureDir(parentDir);
                    }
                    // create and write files
                    console.debug(`[NPM] extract ${targetPath} (${file.size} bytes)`);
                    fs.writeFile(targetPath, file.content);
                }
            }

            if (!this.config.silent) {
                console.log(`✓ ${packageName}@${version} installed to ${packageDir}`);
            }

            return packageDir;
        } catch (error) {
            if (!this.config.silent) {
                console.error(`Failed to auto-install ${packageName}: ${errMsg(error)}`);
            }
            return null;
        }
    }

    /**
     * Get NPM config(compatible)
     */
    private getNpmConfig(): NpmConfig {
        if (this.npmConfig) {
            return this.npmConfig;
        }

        // environ
        try{
            const envRegistry = os.getenv('NPM_CONFIG_REGISTRY');
            if (!envRegistry) throw 0;
            this.npmConfig = { registry: envRegistry };
            return this.npmConfig;
        }catch{}

        // find .npmrc
        const home = os.homedir || '/root';
        const npmrcPath = joinPaths(home, '.npmrc');

        if (fs.exists(npmrcPath)) {
            try {
                const content = readTextFile(npmrcPath);
                const lines = content.split('\n');

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('registry=')) {
                        const registry = trimmed.substring(9).trim();
                        this.npmConfig = { registry };
                        return this.npmConfig;
                    }
                }
            } catch {
                // Ignore
            }
        }

        // use npm default register
        this.npmConfig = { registry: 'https://registry.npmjs.org' };
        return this.npmConfig;
    }

    /**
     * get package meta
     */
    private fetchPackageMetadata(packageName: string, registry: string): NpmPackageMetadata {
        // Handle scoped package
        const encodedName = packageName.replace('/', '%2F');
        const url = `${registry}/${encodedName}`;

        return JSON.parse(fetchSync(url));
    }

    /**
     * download tarball
     */
    private downloadTarball(url: string): ArrayBuffer {
        return fetchBinary(url).buffer;
    }

    /**
     * Parse package name
     */
    private parsePackageName(name: string): ParsedPackageName {
        // Remove version specifier if present (e.g., @opentelemetry/api@^1.9.0)
        const versionMatch = name.match(/(.+?)@[\^~]?\d+\.\d+\.\d+/);
        const packageName = versionMatch ? versionMatch[1] : name;
        
        if (packageName.startsWith('@')) {
            // Scoped package: @scope/pkg/sub
            const parts = packageName.split('/');
            if (parts.length < 2) {
                throw new Error(`Invalid scoped package name: ${name}`);
            }
            const pkgName = `${parts[0]}/${parts[1]}`;
            const subpath = parts.slice(2).join('/');
            return { packageName: pkgName, subpath: subpath };
        } else {
            // Regular package
            const firstSlash = packageName.indexOf('/');
            if (firstSlash === -1) {
                return { packageName: packageName, subpath: '' };
            }
            const pkgName = packageName.substring(0, firstSlash);
            const subpath = packageName.substring(firstSlash + 1);
            return { packageName: pkgName, subpath: subpath };
        }
    }

    /**
     * Find package directory in node_modules
     */
    private findPackageDir(packageName: string, parent: string): string | null {
        const searchPaths = this.getModuleSearchPaths(parent);

        for (const searchPath of searchPaths) {
            const packagePath = joinPaths(searchPath, packageName);
            if (fs.exists(packagePath)) {
                const stats = fs.stat(packagePath);
                if (stats.isDirectory) {
                    return packagePath;
                }
            }
        }

        return null;
    }

    /**
     * Get node_modules search paths
     */
    private getModuleSearchPaths(parent: string): string[] {
        const paths: string[] = [];

        if (parent) {
            let current = dirname(parent);
            const root = sys.platform === 'win32' ? current.split(':')[0] + ':/' : '/';

            while (current && current !== root) {
                const nodeModules = joinPaths(current, 'node_modules');
                if (fs.exists(nodeModules)) {
                    paths.push(nodeModules);
                }
                const parentDir = dirname(current);
                if (parentDir === current) break;
                current = parentDir;
            }
        }

        // Add current working directory node_modules
        const cwd = os.cwd;
        const cwdNodeModules = joinPaths(cwd, 'node_modules');
        if (!paths.includes(cwdNodeModules)) {
            paths.push(cwdNodeModules);
        }

        // Add global cache node_modules
        if (!paths.includes(this.globalCacheDir) && fs.exists(this.globalCacheDir)) {
            paths.push(this.globalCacheDir);
        }

        return paths;
    }

    /**
     * Resolve package.json exports field
     */
    private resolvePackageExports(packageDir: string, subpath: string): string | null {
        try {
            const pkgJsonPath = joinPaths(packageDir, 'package.json');
            if (!fs.exists(pkgJsonPath)) {
                return null;
            }

            const pkgJson: PackageJson = JSON.parse(readTextFile(pkgJsonPath));

            if (!pkgJson.exports) {
                return null;
            }

            // String exports
            if (typeof pkgJson.exports === 'string') {
                if (subpath === '.' || subpath === '') {
                    return joinPaths(packageDir, pkgJson.exports);
                }
                return null;
            }

            // Object exports
            if (typeof pkgJson.exports === 'object') {
                const checkPath = (path: string) => {
                    // @ts-ignore
                    const exportValue = pkgJson.exports![path];
                    if (typeof exportValue === 'string') {
                        // Clean up exportValue to remove leading ./ to avoid double slashes
                        const cleanExportValue = exportValue.startsWith('./') ? exportValue.substring(2) : exportValue;
                        return joinPaths(packageDir, cleanExportValue);
                    }
                    // Conditional exports
                    if (typeof exportValue === 'object') {
                        // prefer import
                        for (const key of ['import', 'default', 'require'])
                            if (typeof exportValue[key] == 'string') {
                                // Clean up exportValue to remove leading ./ to avoid double slashes
                                const cleanExportValue = exportValue[key].startsWith('./') ? exportValue[key].substring(2) : exportValue[key];
                                return joinPaths(packageDir, cleanExportValue);
                            }
                    }
                    return null;
                };

                // as entry?
                if(!subpath) return checkPath(".");

                // Try exact match
                const result = checkPath(subpath);
                if (result) return result;

                // Try with ./ prefix
                const withDot = subpath.startsWith('./') ? subpath : `./${subpath}`;
                return checkPath(withDot);
            }
        } catch {
            // Ignore errors
        }

        return null;
    }

    /**
     * Resolve package main entry point
     */
    private resolvePackageMain(packageDir: string): string {
        try {
            const pkgJsonPath = joinPaths(packageDir, 'package.json');
            if (fs.exists(pkgJsonPath)) {
                const pkgJson: PackageJson = JSON.parse(readTextFile(pkgJsonPath));

                // Try exports field
                if (pkgJson.exports) {
                    const exported = this.resolvePackageExports(packageDir, '.');
                    if (exported) {
                        return tryResolveFile(exported);
                    }
                }

                // Try module field
                if (pkgJson.module) {
                    const modulePath = joinPaths(packageDir, pkgJson.module);
                    if (fs.exists(modulePath)) {
                        return modulePath;
                    }
                }

                // Try main field
                if (pkgJson.main) {
                    const mainPath = joinPaths(packageDir, pkgJson.main);
                    return tryResolveFile(mainPath);
                }
            }
        } catch {
            // Fall through
        }

        // Default to index files
        return tryResolveFile(joinPaths(packageDir, 'index'));
    }
}