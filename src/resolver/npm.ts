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
    fetchBinary,
    resolveVersion
} from '../utils';
import { BaseResolver, type ResolveResult, type LocalPathResult, ModuleType } from './base.js';
import {
    readPackageJsonNoCache,
    resolveMainEntry as resolveMainEntryUtil,
    resolveSubpath as resolveSubpathUtil,
    createResolveContext
} from '../package';

const fs = import.meta.use('fs');
const sys = import.meta.use('sys');
const console = import.meta.use('console');
const os = import.meta.use('os');

interface NpmConfig {
    registry: string;
}

interface PackageMetadata {
    name: string;
    versions: Record<string, {
        version: string;
        dist: {
            tarball: string;
            shasum?: string;
        };
        dependencies?: Record<string, string>;
    }>;
    'dist-tags': {
        latest: string;
        [tag: string]: string;
    };
}

interface PackageCacheEntry {
    pkg: ResolvedPackage;
    lastChecked: number;
}

class ResolvedPackage {
    private metadata: PackageMetadata | null = null;
    private packageJson: PackageJson | null = null;
    private installed: boolean = false;

    constructor(
        public readonly name: string,
        public readonly version: string,
        public readonly dir: string,
        private readonly config: RuntimeConfig,
        private readonly npmConfig: NpmConfig
    ) {}

    loadMetadata(): PackageMetadata {
        if (this.metadata) return this.metadata;

        const cachePath = joinPaths(this.config.cacheDir, 'npm', this.name, 'meta.json');

        if (fs.exists(cachePath)) {
            try {
                this.metadata = JSON.parse(readTextFile(cachePath));
                return this.metadata!;
            } catch {
                console.debug(`[NPM] Failed to parse cached metadata for ${this.name}`);
            }
        }

        const url = `${this.npmConfig.registry}/${this.name}`;

        try {
            console.debug(`[NPM] Fetching metadata: ${url}`);
            const response = fetchSync(url);
            this.metadata = JSON.parse(response);

            ensureDir(dirname(cachePath));
            writeTextFile(cachePath, JSON.stringify(this.metadata, null, 2));

            return this.metadata!;
        } catch (error) {
            throw new Error(`Failed to fetch metadata for ${this.name}: ${errMsg(error)}`);
        }
    }

    setMetadata(meta: PackageMetadata): void {
        this.metadata = meta;
    }

    install(): void {
        if (this.installed) return;

        const meta = this.loadMetadata();
        const versionData = meta.versions[this.version];

        if (!versionData) {
            throw new Error(`Version ${this.version} not found for ${this.name}`);
        }

        console.debug(`[NPM] Installing ${this.name}@${this.version}`);
        const tarballUrl = versionData.dist.tarball;
        const tarballData = this.downloadTarball(tarballUrl);

        console.debug(`[NPM] Extracting to ${this.dir}`);
        const files = unTarGz(tarballData);
        ensureDir(this.dir);

        const ensuredDirs = new Set<string>();

        for (const file of files) {
            let filePath = normalizePath(file.path);
            if (filePath.startsWith('package/')) {
                filePath = filePath.substring(8);
            }

            const targetPath = joinPaths(this.dir, filePath);

            if (file.type === 'dir') {
                if (!ensuredDirs.has(targetPath)) {
                    ensureDir(targetPath);
                    ensuredDirs.add(targetPath);
                }
            } else {
                const parentDir = dirname(targetPath);
                if (!ensuredDirs.has(parentDir)) {
                    ensureDir(parentDir);
                    ensuredDirs.add(parentDir);
                }
                fs.writeFile(targetPath, file.content);
            }
        }

        this.installed = true;
        console.debug(`[NPM] Installed ${this.name}@${this.version}`);
    }

    private downloadTarball(url: string): ArrayBuffer {
        try {
            return fetchBinary(url, 5, true).buffer;
        } catch (error) {
            throw new Error(`Failed to download tarball: ${errMsg(error)}`);
        }
    }

    loadPackageJson(): PackageJson {
        if (this.packageJson) return this.packageJson;

        const pkg = readPackageJsonNoCache(this.dir);
        if (!pkg) {
            throw new Error(`package.json not found in ${this.dir}`);
        }

        this.packageJson = pkg;
        return this.packageJson;
    }

    resolveSubpath(subpath: string): string | null {
        const context = createResolveContext(this.dir);
        if (!context) {
            throw new Error(`Failed to resolve package context for ${this.dir}`);
        }

        return resolveSubpathUtil(context, subpath);
    }
}

export class NpmResolver extends BaseResolver {
    private readonly globalCacheDir: string;
    private npmConfig: NpmConfig | null = null;
    private readonly packageCache = new Map<string, PackageCacheEntry>();
    private readonly CACHE_TTL = 5 * 60 * 1000;

    readonly protocol = ['npm'];

    constructor(private readonly config: RuntimeConfig) {
        super();
        this.globalCacheDir = joinPaths(this.config.cacheDir, 'npm');
    }

    resolve(specifier: string, parent?: string, attr?: Record<string, any>): ResolveResult {
        const cleanSpec = this.cleanSpecifier(specifier);
        const { name, version, subpath } = this.parseSpecifier(cleanSpec);

        console.debug(`[NPM] Resolving: name="${name}", version="${version}", subpath="${subpath}"`);

        const pkg = this.resolvePackage(name, version, parent);
        if (!pkg) {
            throw new Error(`Package "${name}" not found`);
        }

        const resolvedPath = pkg.resolveSubpath(subpath);
        if (!resolvedPath) {
            throw new Error(`Cannot resolve "${subpath || 'main'}" from ${name}@${pkg.version}`);
        }

        // Check if this is a CJS module
        const isCjs = this.detectModuleType(resolvedPath) === ModuleType.CJS;

        console.debug(`[NPM] Resolved to: ${resolvedPath}, isCjs: ${isCjs}`);
        return { path: resolvedPath, isCjs };
    }

    /**
     * Check if a module is CommonJS (public API for loader)
     */

    private findPackageDirFromPath(filePath: string): string | null {
        // Try to find package.json by walking up from file path
        let dir = dirname(filePath);
        while (dir !== '/' && dir !== '.') {
            if (fs.exists(joinPaths(dir, 'package.json'))) {
                return dir;
            }
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }

    getLocalPath(url: string): LocalPathResult {
        // Extract local path from npm URL
        const cleanSpec = this.cleanSpecifier(url);
        const { name, version, subpath } = this.parseSpecifier(cleanSpec);
        const pkg = this.resolvePackage(name, version);
        if (!pkg) {
            throw new Error(`Package not found: ${name}`);
        }
        const resolvedPath = pkg.resolveSubpath(subpath);
        if (!resolvedPath) {
            throw new Error(`Cannot resolve subpath: ${subpath}`);
        }

        // Determine module type
        const moduleType = this.detectModuleType(resolvedPath);

        return { path: resolvedPath, moduleType };
    }

    private detectModuleType(filePath: string): ModuleType {
        const ext = filePath.substring(filePath.lastIndexOf('.'));
        
        // .mjs is always ESM
        if (ext === '.mjs') return ModuleType.ESM;
        // .cjs is always CJS
        if (ext === '.cjs') return ModuleType.CJS;
        
        // For .js files, check package.json
        if (ext === '.js') {
            const pkgDir = this.findPackageDirFromPath(filePath);
            if (!pkgDir) return ModuleType.UNKNOWN;
            
            const pkgJson = readPackageJsonNoCache(pkgDir);
            // If type is "module", it's ESM; otherwise CJS
            return pkgJson?.type === 'module' ? ModuleType.ESM : ModuleType.CJS;
        }
        
        // Default to ESM for other extensions
        return ModuleType.ESM;
    }

    private cleanSpecifier(spec: string): string {
        if (spec.startsWith('npm:')) {
            return spec.substring(4);
        }
        return spec;
    }

    private parseSpecifier(spec: string): { name: string; version: string; subpath: string } {
        let name = '';
        let version = '';
        let subpath = '';
        let rest = spec;

        // Handle scoped packages @scope/name
        if (rest.startsWith('@')) {
            const slashIndex = rest.indexOf('/');
            if (slashIndex === -1) throw new Error(`Invalid scoped package: ${spec}`);

            const scope = rest.substring(0, slashIndex);
            rest = rest.substring(slashIndex + 1);

            // Find where name ends (at @version or /subpath)
            const atIndex = rest.indexOf('@');
            const slashIndex2 = rest.indexOf('/');

            if (atIndex !== -1 && (slashIndex2 === -1 || atIndex < slashIndex2)) {
                // Has version: name@version/subpath
                name = `${scope}/${rest.substring(0, atIndex)}`;
                const afterAt = rest.substring(atIndex + 1);
                const slashInVer = afterAt.indexOf('/');
                version = slashInVer === -1 ? afterAt : afterAt.substring(0, slashInVer);
                subpath = slashInVer === -1 ? '' : afterAt.substring(slashInVer + 1);
            } else if (slashIndex2 !== -1) {
                // Has subpath: name/subpath
                name = `${scope}/${rest.substring(0, slashIndex2)}`;
                subpath = rest.substring(slashIndex2 + 1);
            } else {
                // Just name
                name = `${scope}/${rest}`;
            }
        } else {
            // Non-scoped: name, name@version, name/subpath, name@version/subpath
            const atIndex = rest.indexOf('@');
            const slashIndex = rest.indexOf('/');

            if (atIndex !== -1 && (slashIndex === -1 || atIndex < slashIndex)) {
                // Has version
                name = rest.substring(0, atIndex);
                const afterAt = rest.substring(atIndex + 1);
                const slashInVer = afterAt.indexOf('/');
                version = slashInVer === -1 ? afterAt : afterAt.substring(0, slashInVer);
                subpath = slashInVer === -1 ? '' : afterAt.substring(slashInVer + 1);
            } else if (slashIndex !== -1) {
                // Has subpath only
                name = rest.substring(0, slashIndex);
                subpath = rest.substring(slashIndex + 1);
            } else {
                // Just name
                name = rest;
            }
        }

        return { name, version: version || 'latest', subpath };
    }

    private resolvePackage(name: string, version: string, parent?: string): ResolvedPackage | null {
        const cacheKey = `${name}@${version}`;
        const cached = this.packageCache.get(cacheKey);
        if (cached && (Date.now() - cached.lastChecked) < this.CACHE_TTL) {
            return cached.pkg;
        }

        let pkgDir = this.findPackageDir(name, parent);
        let resolvedVersion = version;

        if (!pkgDir) {
            const result = this.installPackage(name, version);
            if (!result) return null;
            pkgDir = result.dir;
            resolvedVersion = result.version;
        } else {
            resolvedVersion = this.readVersionFromDir(pkgDir) || version;
        }

        const pkg = new ResolvedPackage(name, resolvedVersion, pkgDir, this.config, this.getNpmConfig());
        this.packageCache.set(cacheKey, { pkg, lastChecked: Date.now() });
        return pkg;
    }

    private readVersionFromDir(dir: string): string | null {
        try {
            const pkgJsonPath = joinPaths(dir, 'package.json');
            if (fs.exists(pkgJsonPath)) {
                return JSON.parse(readTextFile(pkgJsonPath)).version;
            }
        } catch {}
        return null;
    }

    private installPackage(name: string, version: string): { dir: string; version: string } | null {
        try {
            if (!this.config.silent) {
                console.log(`📦 npx ${name}@${version}`);
            }

            const npmConfig = this.getNpmConfig();
            const tempPkg = new ResolvedPackage(name, version, '', this.config, npmConfig);
            const metadata = tempPkg.loadMetadata();

            const resolvedVersion = this.resolveVersion(version, metadata);
            const pkgDir = joinPaths(this.globalCacheDir, `${name}@${resolvedVersion}`);

            if (fs.exists(pkgDir)) {
                return { dir: pkgDir, version: resolvedVersion };
            }

            const pkg = new ResolvedPackage(name, resolvedVersion, pkgDir, this.config, npmConfig);
            pkg.setMetadata(metadata);
            pkg.install();

            return { dir: pkgDir, version: resolvedVersion };
        } catch (error) {
            console.error(`[NPM] Failed to install ${name}@${version}:`, error);
            return null;
        }
    }

    private resolveVersion(version: string, metadata: PackageMetadata): string {
        if (version === 'latest' || version === '') {
            return metadata['dist-tags']?.latest || this.getLatestVersion(metadata);
        }
        if (/^\d+\.\d+\.\d+/.test(version)) {
            return version;
        }
        // Version range like ^1.0.0 or ~2.0.0
        const matched = matchLatestVersion(Object.keys(metadata.versions), version);
        return matched || version;
    }

    private getLatestVersion(metadata: PackageMetadata): string {
        const versions = Object.keys(metadata.versions);
        if (versions.length === 0) {
            throw new Error('No versions available');
        }
        return versions[versions.length - 1]!;
    }

    private findPackageDir(name: string, parent?: string): string | null {
        for (const searchPath of this.getSearchPaths(parent)) {
            // Try exact match first
            const exactPath = joinPaths(searchPath, name);
            if (this.isValidPackageDir(exactPath)) {
                return exactPath;
            }

            // For non-scoped packages, try versioned directories (name@version)
            if (!name.startsWith('@')) {
                const versioned = this.findVersionedDir(searchPath, name);
                if (versioned) return versioned;
            }
        }
        return null;
    }

    private isValidPackageDir(dir: string): boolean {
        try {
            return fs.stat(dir).isDirectory && fs.exists(joinPaths(dir, 'package.json'));
        } catch {
            return false;
        }
    }

    private findVersionedDir(searchPath: string, name: string): string | null {
        try {
            for (const entry of fs.readdir(searchPath) || []) {
                if (entry.startsWith(name + '@')) {
                    const entryPath = joinPaths(searchPath, entry);
                    if (fs.stat(entryPath).isDirectory) {
                        return entryPath;
                    }
                }
            }
        } catch {}
        return null;
    }

    private getSearchPaths(parent?: string): string[] {
        const paths: Set<string> = new Set();

        // Walk up from parent directory
        if (parent) {
            let current = dirname(parent);
            const root = sys.platform === 'win32' ? current.split(':')[0] + ':/' : '/';

            while (current && current !== root) {
                paths.add(joinPaths(current, 'node_modules'));
                const parentDir = dirname(current);
                if (parentDir === current) break;
                current = parentDir;
            }
        }

        // Current working directory
        paths.add(joinPaths(os.cwd, 'node_modules'));

        // Global cache
        if (fs.exists(this.globalCacheDir)) {
            paths.add(this.globalCacheDir);
        }

        return Array.from(paths);
    }

    private getNpmConfig(): NpmConfig {
        if (this.npmConfig) return this.npmConfig;

        try {
            const envRegistry = os.getenv('NPM_CONFIG_REGISTRY');
            if (envRegistry) {
                this.npmConfig = { registry: envRegistry };
                return this.npmConfig;
            }
        } catch {}

        try {
            const home = os.homedir || '/root';
            const npmrcPath = joinPaths(home, '.npmrc');
            if (fs.exists(npmrcPath)) {
                const content = readTextFile(npmrcPath);
                const match = content.match(/^registry\s*=\s*(.+)$/m);
                if (match) {
                    this.npmConfig = { registry: match[1]!.trim() };
                    return this.npmConfig;
                }
            }
        } catch {}

        this.npmConfig = { registry: 'https://registry.npmjs.org' };
        return this.npmConfig;
    }

    resolveAndInstallSync(spec: string, parent?: string): ResolvedPackage | null {
        const { name, version } = this.parseSpecifier(this.cleanSpecifier(spec));
        return this.resolvePackage(name, version, parent);
    }

    clearCache(): void {
        this.packageCache.clear();
    }
}
