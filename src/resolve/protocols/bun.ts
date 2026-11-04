import type { ModuleInfo, RuntimeConfig } from '../../types';
import { StepType, type Flow } from '../../flow';
import { err, ErrorKind } from '../../errors';
import { dirname, isPathWithin, joinPaths, normalizePath, relativePath, resolvePath, toPosixPath } from '../../utils/path';
import type { ProtocolHandler } from './base';
import { bunPayloadViewName, canonicalBunSpecifier, type BunModule } from '../bun-specifier';

const fs = import.meta.use('fs');
const SETUP_PUBLISH_DIR = '.setup-publish';

export { BUN_MODULES, canonicalBunSpecifier, isBunSpecifier } from '../bun-specifier';

/** Unknown or malformed `bun:*` name. Never falls back to npm, maps or network. */
export function unknownBunBuiltin(spec: string): Error {
    return err(ErrorKind.ModuleNotFound, `Unknown Bun builtin "${spec}"`,
        undefined, 'ERR_UNKNOWN_BUILTIN_MODULE');
}

function unavailableBunBuiltin(name: BunModule, path: string): Error {
    return err(ErrorKind.FileNotFound, `Bun builtin "${name}" has no polyfill at ${path}`,
        undefined, 'ERR_UNKNOWN_BUILTIN_MODULE');
}

/**
 * Bun follows the Node builtin model: setup installs TypeScript sources under
 * cacheDir/bun, then CTS transforms and caches them on demand. `specPath`
 * remains the canonical builtin identity while `localPath` points at source.
 */
export class BunHandler implements ProtocolHandler {
    readonly protocols = ['bun'];
    private readonly cacheRoot: string;
    private readonly bunRoot: string;
    private readonly nodeRoot: string;
    private readonly utilsRoot: string;
    private readonly resolvedSources = new Map<BunModule, string>();
    // Internal refs are capabilities, not paths.  Keep the set private so a
    // caller cannot manufacture a bun-internal parent by spelling a cache path.
    private readonly issuedInternals = new Map<string, string>();
    private readonly issuedNodeSources = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {
        this.cacheRoot = normalizePath(resolvePath(cfg.cacheDir));
        this.bunRoot = joinPaths(this.cacheRoot, 'bun');
        this.nodeRoot = joinPaths(this.cacheRoot, 'node');
        this.utilsRoot = joinPaths(this.cacheRoot, 'utils');
    }

    *resolve(spec: string, parent: string): Flow<ModuleInfo> {
        if (spec.startsWith('./') || spec.startsWith('../')) {
            return yield* this.resolveInternal(spec, parent);
        }
        const name = canonicalBunSpecifier(spec);
        if (!name) throw unknownBunBuiltin(spec);
        const localPath = yield* this.findSourcePath(name);
        this.resolvedSources.set(name, localPath);
        return { specPath: name, localPath, format: 'esm', fileKind: 'source' };
    }

    localPath(specPath: string): string {
        const name = canonicalBunSpecifier(specPath);
        if (!name) throw unknownBunBuiltin(specPath);
        return this.sourceCandidates(name)[0]!;
    }

    isIssuedInternal(specPath: string): boolean {
        return this.issuedInternals.has(specPath);
    }

    /** True only after this resolver has verified the public Bun source. */
    isTrustedParent(specPath: string): boolean {
        if (this.issuedInternals.has(specPath)) return true;
        if (this.issuedNodeSources.has(specPath)) return true;
        const name = canonicalBunSpecifier(specPath) ?? bunPayloadViewName(specPath);
        return name !== null && this.resolvedSources.has(name);
    }

    isTrustedNodeParent(specPath: string): boolean {
        return this.issuedNodeSources.has(specPath);
    }

    issueNodeSource(info: ModuleInfo, spec: string, parent: string): void {
        this.assertManagedSource(info.localPath, spec, parent);
        this.issuedNodeSources.set(info.specPath, info.localPath);
    }

    private sourceCandidates(name: BunModule): string[] {
        const subpath = name === 'bun' ? '' : name.slice(4);
        const base = normalizePath(joinPaths(this.bunRoot, subpath));
        return name === 'bun'
            ? [joinPaths(base, 'index.ts')]
            : [`${base}.ts`, joinPaths(base, 'index.ts')];
    }

    private *findSourcePath(name: BunModule): Flow<string> {
        const candidates = this.sourceCandidates(name);
        for (const path of candidates) {
            const exists = yield { type: StepType.FS_EXISTS, path };
            if (!exists) continue;
            // FS_EXISTS is lexical; a setup source symlink must not redirect
            // Bun's runtime implementation outside the managed cache.
            this.assertCacheOwned(path, name, '');
            return path;
        }
        throw unavailableBunBuiltin(name, candidates.join(' or '));
    }

    /** Resolve imports only after the parent has been identified as Bun source. */
    private *resolveInternal(spec: string, parent: string): Flow<ModuleInfo> {
        const parentPath = this.internalParentPath(parent);
        if (!parentPath) throw unknownBunBuiltin(spec);
        this.assertCacheOwned(parentPath, spec, parent);
        const base = normalizePath(joinPaths(dirname(parentPath), spec));
        if (!this.managedRoot(base)) {
            throw err(ErrorKind.ModuleNotFound,
                `Relative Bun import "${spec}" from "${parent}" escapes the setup source cache`);
        }
        const candidates = [`${base}.ts`, joinPaths(base, 'index.ts')];
        for (const localPath of candidates) {
            const exists = yield { type: StepType.FS_EXISTS, path: localPath };
            if (!exists) continue;
            this.assertCacheOwned(localPath, spec, parent);
            const specPath = this.internalSpecPath(localPath);
            if (specPath.startsWith('bun-internal:')) {
                this.issuedInternals.set(specPath, localPath);
            } else if (specPath.startsWith('node:')) {
                this.issuedNodeSources.set(specPath, localPath);
            }
            return {
                specPath,
                localPath,
                format: 'esm',
                fileKind: 'source',
            };
        }
        throw err(ErrorKind.FileNotFound,
            `Cannot resolve Bun source import "${spec}" from "${parentPath}"`);
    }

    private internalParentPath(parent: string): string | null {
        const name = canonicalBunSpecifier(parent) ?? bunPayloadViewName(parent);
        // A canonical spelling is not proof that this resolver issued it as a
        // parent. This also prevents `bun:fake` from becoming a path oracle.
        if (name) return this.resolvedSources.get(name) ?? null;
        const prefix = 'bun-internal:';
        if (!parent.startsWith(prefix)) return null;
        // Do not decode and reconstruct arbitrary paths here.  Only refs
        // emitted by resolveInternal are valid parents.
        return this.issuedInternals.get(parent) ?? null;
    }

    private internalSpecPath(localPath: string): string {
        const node = relativePath(this.nodeRoot, localPath);
        if (node !== null) {
            // Match NodeHandler's public layout exactly. A top-level `x.ts`
            // and a nested `x/y/index.ts` do not map to `node:x`/`node:x/y`;
            // keeping them internal preserves the real parent directory.
            const directoryEntry = node.endsWith('/index.ts')
                ? node.slice(0, -'/index.ts'.length)
                : null;
            const fileEntry = node.endsWith('.ts')
                ? node.slice(0, -'.ts'.length)
                : null;
            const bare = directoryEntry && !directoryEntry.includes('/')
                ? directoryEntry
                : fileEntry?.includes('/') ? fileEntry : null;
            if (bare) return `node:${bare}`;
        }
        const relative = localPath.slice(this.cacheRoot.length).replace(/^\/+/, '');
        return `bun-internal:${encodeURIComponent(relative)}`;
    }

    private managedRoot(localPath: string): string | null {
        const normalized = normalizePath(localPath);
        for (const root of [this.bunRoot, this.nodeRoot, this.utilsRoot]) {
            if (isPathWithin(root, normalized)) return root;
        }
        return null;
    }

    private assertCacheOwned(localPath: string, spec: string, parent: string): void {
        const managedRoot = this.managedRoot(localPath);
        try {
            if (!managedRoot) throw new Error('not a setup-managed source path');
            // Remote setup publishes three source trees under an exclusive
            // writer lock. Readers fail closed during the short rename window
            // instead of observing a cross-revision dependency graph.
            if (fs.exists(joinPaths(this.cacheRoot, SETUP_PUBLISH_DIR))) {
                throw new Error('setup publication is in progress');
            }
            const realRoot = normalizePath(toPosixPath(fs.realpath(this.cacheRoot)));
            const realManagedRoot = normalizePath(toPosixPath(fs.realpath(managedRoot)));
            const realPath = normalizePath(toPosixPath(fs.realpath(localPath)));
            if (isPathWithin(realRoot, realManagedRoot)
                && isPathWithin(realManagedRoot, realPath)) return;
        } catch {
            // The preceding existence check is not an ownership check. Treat a
            // failed realpath as an invalid setup source rather than following it.
        }
        throw err(ErrorKind.ModuleNotFound,
            `Relative Bun import "${spec}" from "${parent}" escapes the setup source cache`);
    }

    /** Validate a Node/shared source reached from a Bun implementation. */
    assertManagedSource(localPath: string, spec: string, parent: string): void {
        this.assertCacheOwned(localPath, spec, parent);
    }
}
