import { moduleRef, moduleViewRef, type RuntimeConfig, type ModuleInfo, type NodeBuiltinResolver, type FileKind, type LifecycleScriptEntry } from '../types';
import type { ProtocolHandler } from './protocols/base';
import type { Flow, ProgressCallback } from '../flow';
import { err, ErrorKind } from '../errors';
import { FileHandler } from './protocols/file';
import { HttpHandler }  from './protocols/http';
import { JsrHandler }   from './protocols/jsr';
import { NpmHandler }   from './protocols/npm';
import { NodeHandler }  from './protocols/node';
import { DataHandler }  from './protocols/data';
import { BlobHandler }  from './protocols/blob';
import { LockStore }    from '../lock';
import { isBuiltinSpecifier } from './builtins';
import { runAsync, runSync } from '../flow';
import { fileUrlToPath, normalizePath, joinPaths, isAbsolute, dirname, resolvePath, isRelative, canonicalizePath, resolveFile, parentDirKey, assert, LRU, log, schemeId } from '../utils';
import { detectFormat } from './pkg';
import { guessFileKind, applyAttrType, validateAttrType } from './protocols/base';

const os = import.meta.use('os');
const fs = import.meta.use('fs');

// protoOf — extract protocol prefix without regex
// Returns '' for relative/absolute paths, 'http' for 'http://...', etc.

function protoOf(s: string): string {
    return schemeId(s) ?? '';
}

/**
 * Node resolves ESM specifiers as URLs, so `./with%20space.mjs` refers to the
 * file `with space.mjs`. Try the literal path first (a file may legitimately
 * contain '%'), then the percent-decoded form.
 */
function resolveLocalFile(path: string): string {
    // ESM specifiers are URLs: encoded separators are invalid even when a file
    // with the literal `%2F`/`%5C` spelling exists. Encoded dot segments would
    // otherwise become `..` after decoding below and escape the importer's
    // directory. Reject those forms before trying the literal path.
    if (path.includes('%')) {
        if (/%(?:2f|5c)/i.test(path)) {
            throw err(ErrorKind.InvalidSpecifier,
                `Invalid module specifier: encoded path separator in "${path}"`);
        }
        for (const segment of path.split('/')) {
            // Only ENCODED dot segments are rejected. A literal `..` is legal here:
            // resolveRelative normalises it away before calling, and resolveAbsolute
            // passes an already-absolute path. Testing segments without a '%' would
            // reject any path that merely contains '%' elsewhere (`/dir%20x/../y`).
            if (!segment.includes('%')) continue;
            if (!/(?:%2e|\.){1,2}$/i.test(segment)) continue;
            let decoded: string;
            try { decoded = decodeURIComponent(segment); }
            catch { continue; }
            if (decoded === '.' || decoded === '..') {
                throw err(ErrorKind.InvalidSpecifier,
                    `Invalid module specifier: encoded dot segment in "${path}"`);
            }
        }
    }
    try {
        return resolveFile(path);
    } catch (e) {
        if (path.indexOf('%') === -1) throw e;
        let decoded: string;
        try {
            decoded = normalizePath(decodeURIComponent(path));
        } catch {
            throw e;
        }
        if (decoded === path) throw e;
        try {
            return resolveFile(decoded);
        } catch {
            throw e;
        }
    }
}

/** Skip empty-prefix aliases when spec is already a real absolute/drive path. */
function isRealAbsolutePath(spec: string): boolean {
    if (!spec) return false;
    if (spec.length >= 3) {
        const c0 = spec.charCodeAt(0);
        const alpha = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
        if (alpha && spec.charCodeAt(1) === 58 /* : */) {
            const sep = spec.charCodeAt(2);
            if (sep === 47 || sep === 92) return true;
        }
    }
    if (spec.charCodeAt(0) !== 47 /* / */) return false;
    try {
        return fs.exists(spec);
    } catch {
        return false;
    }
}

function isFilesystemLocalPath(spec: string): boolean {
    if (!spec) return false;
    if (spec.charCodeAt(0) === 47 /* / */) return true;
    // Windows drive: C:\ or C:/
    if (spec.length >= 3) {
        const c0 = spec.charCodeAt(0);
        const alpha = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
        if (alpha && spec.charCodeAt(1) === 58 /* : */) {
            const sep = spec.charCodeAt(2);
            if (sep === 47 || sep === 92) return true;
        }
    }
    return false;
}

// Strip URL query/fragment only. Absolute filesystem paths may contain a
// real directory named "#" (es5-ext); never treat that as a fragment.
function splitLocalSpecifier(spec: string, splitAbsoluteSuffix = false): { path: string; suffix: string } {
    if (isFilesystemLocalPath(spec) && !splitAbsoluteSuffix) return { path: spec, suffix: '' };
    const query = spec.indexOf('?');
    const hash = spec.indexOf('#');
    const cut = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash);
    return cut === -1
        ? { path: spec, suffix: '' }
        : { path: spec.slice(0, cut), suffix: spec.slice(cut) };
}

interface ImportMapMappingsIndex {
    exact:    Map<string, string>;
    prefixes: Array<[string, string]>; // [prefix/, target] longest-first
}

interface ImportMapIndex {
    imports: ImportMapMappingsIndex;
    scopes:  Array<[string, ImportMapMappingsIndex]>; // [scope prefix, mappings] longest-first
}

function buildImportMapMappingsIndex(map: Record<string, string> | undefined): ImportMapMappingsIndex {
    const exact    = new Map<string, string>();
    const prefixes: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(map ?? {})) {
        if (k.endsWith('/')) prefixes.push([k, v]);
        else exact.set(k, v);
    }
    prefixes.sort((a, b) => b[0].length - a[0].length);
    return { exact, prefixes };
}

function normalizeImportMapScopeRef(ref: string): string {
    let normalized = ref;
    if (schemeId(ref) === 'file') normalized = fileUrlToPath(ref);
    if (!isFilesystemLocalPath(normalized)) return normalized;
    const keepTrailingSlash = normalized.endsWith('/');
    normalized = canonicalizePath(normalizePath(normalized));
    return keepTrailingSlash && !normalized.endsWith('/') ? normalized + '/' : normalized;
}

function buildImportMapIndex(
    imports: Record<string, string> | undefined,
    scopes: Record<string, Record<string, string>> | undefined,
): ImportMapIndex | null {
    if (!imports && !scopes) return null;
    const scopeIndex: Array<[string, ImportMapMappingsIndex]> = [];
    for (const [scope, mappings] of Object.entries(scopes ?? {})) {
        scopeIndex.push([normalizeImportMapScopeRef(scope), buildImportMapMappingsIndex(mappings)]);
    }
    scopeIndex.sort((a, b) => b[0].length - a[0].length);
    return { imports: buildImportMapMappingsIndex(imports), scopes: scopeIndex };
}

function matchImportMap(spec: string, idx: ImportMapMappingsIndex): string | undefined {
    const exact = idx.exact.get(spec);
    if (exact !== undefined) return exact;
    for (const [prefix, target] of idx.prefixes) {
        if (spec.startsWith(prefix)) return target + spec.slice(prefix.length);
    }
    // Preserve the legacy bare-specifier subpath fallback.
    let slash = spec.lastIndexOf('/');
    while (slash > 0) {
        const mapped = idx.exact.get(spec.slice(0, slash));
        if (mapped !== undefined) return `${mapped}/${spec.slice(slash + 1)}`;
        slash = spec.lastIndexOf('/', slash - 1);
    }
    return undefined;
}

interface PathAliasEntry {
    prefix:   string;
    wildcard: boolean;
    targets:  string[];
}

function isExternalAliasTarget(target: string): boolean {
    return protoOf(target) !== '' || target.startsWith('//');
}

function normalizeAliasTarget(target: string, baseUrl?: string): string {
    if (!baseUrl || isExternalAliasTarget(target) || isAbsolute(target)) return target;
    return normalizePath(joinPaths(baseUrl, target));
}

function buildAliasIndex(aliases: Record<string, string[]>, baseUrl?: string): PathAliasEntry[] {
    const entries: PathAliasEntry[] = [];
    for (const alias in aliases) {
        // tsconfig `paths` values are an ordered fallback list — keep all of them.
        const normalized: string[] = [];
        for (const target of aliases[alias] ?? []) {
            if (!target) continue;
            normalized.push(normalizeAliasTarget(target.endsWith('/*') ? target.slice(0, -2) : target, baseUrl));
        }
        if (!normalized.length) continue;
        const wildcard = alias.endsWith('/*');
        entries.push({ prefix: wildcard ? alias.slice(0,-2) : alias, wildcard, targets: normalized });
    }
    return entries;
}

export class ModuleResolver {
    private readonly handlers    = new Map<string, ProtocolHandler>();
    private readonly disabled    = new Set<string>();
    private readonly lock:         LockStore;
    get lockStore(): LockStore { return this.lock; }
    private readonly importIndex:  ImportMapIndex | null;
    private readonly aliasIndex:   PathAliasEntry[];
    private mainEntry = '';
    /** specPath → ModuleInfo — live resolution cache. */
    private readonly resolvedModules = new Map<string, ModuleInfo>();
    /** runtime module ref → ModuleInfo for non-canonical engine-facing module views. */
    private readonly runtimeModules = new Map<string, ModuleInfo>();
    /** In-memory (spec, parent) → ModuleInfo cache — skips SQLite on repeat resolves. */
    private readonly resolveCache = new LRU<string, ModuleInfo>(4096);
    /** Mode-aware source cache for cjs-vs-esm lookups in the current runtime. */
    private readonly sourceInfoCache = new LRU<string, ModuleInfo>(4096);

    constructor(
        private readonly cfg: RuntimeConfig,
        lockDir?: string,
        lockReadOnly = false,
    ) {
        this.lock        = new LockStore(lockDir ?? os.cwd, lockReadOnly, cfg.disableLock === true);
        cfg.lockStore = this.lock;
        this.importIndex = buildImportMapIndex(cfg.importMap, cfg.importMapScopes);
        this.aliasIndex  = cfg.pathAliases  ? buildAliasIndex(cfg.pathAliases, cfg.baseUrl) : [];
        this.lock.load();

        this.reg(new FileHandler(cfg));
        this.reg(new DataHandler(cfg));
        this.reg(new BlobHandler(cfg));
        this.reg(new NpmHandler(cfg, (spec, parent, attr, onProgress) =>
            this.resolvePackageImportTarget(spec, parent, attr, onProgress)));

        const flagged: Array<[ProtocolHandler, keyof RuntimeConfig]> = [
            [new HttpHandler(cfg), 'enableHttp'],
            [new JsrHandler(cfg),  'enableJsr'],
            [new NodeHandler(cfg), 'enableNode'],
        ];
        for (const [h, flag] of flagged) {
            this.reg(h);
            if (!cfg[flag]) for (const p of h.protocols) this.disabled.add(p);
        }
    }

    private reg(h: ProtocolHandler): void {
        for (const p of h.protocols) this.handlers.set(p, h);
    }

    /**
     * Release the lock store this resolver owns. Without it the SQLite handle
     * stays open until process exit (LockStore.closeAll), so a caller cannot
     * delete the lock dir in-process — on Windows unlink then fails EINVAL.
     */
    close(): void {
        this.lock.close();
    }

    /** Register a `pack:` handler for an active .jspack container run (see pack/reader.ts). */
    registerPackHandler(h: ProtocolHandler): void {
        this.reg(h);
    }

    set entry(s: string) { this.mainEntry = s; }
    get entry(): string  { return this.mainEntry; }

    registerNodeResolver(r: NodeBuiltinResolver): void {
        const h = this.handlers.get('node');
        assert(h instanceof NodeHandler, 'node handler not registered');
        h.registerResolver(r);
    }

    moduleRef(info: Pick<ModuleInfo, 'specPath' | 'moduleId'>): string {
        return moduleRef(info);
    }

    // Async resolution — used by DepScanner during precache for parallel downloads
    // Falls back to sync resolve when no async handler available (file, data, node).

    async resolveAsync(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        log.debug('resolver', () => `resolveAsync "${spec}" from "${parent}"`);

        parent = this.normalizeParentRef(parent);
        const requestSpec = spec;
        // Exact cache is keyed by the caller's specifier (see exactResolveKey).
        if (!attr) {
            const hit = this.resolveCache.get(this.exactResolveKey(requestSpec, parent));
            if (hit) return hit;
        }
        if (spec.includes('\\') || spec[1] === ':') spec = canonicalizePath(spec);

        // pack: parent — resolve original specifier before maps/lock redirect out.
        if (protoOf(parent) === 'pack') {
            const packedSpec = spec.startsWith('node:') || isBuiltinSpecifier(spec)
                ? (spec.startsWith('node:') ? spec : `node:${spec}`)
                : null;
            const info = packedSpec
                ? await this.dispatchAsync(packedSpec, parent, attr, onProgress)
                : await runAsync(this.packHandler().resolve(spec, parent, attr, onProgress));
            return this.publishResolved(requestSpec, spec, parent, info, attr, { rememberExact: true });
        }

        const mapped = (isRelative(spec) || isAbsolute(spec)) ? spec : this.applyImportMap(spec, parent);
        const sourceKey = this.sourceCacheKey(mapped, parent, attr);
        const sourceHit = this.sourceInfoCache.get(sourceKey);
        if (sourceHit) {
            this.rememberExact(requestSpec, parent, attr, sourceHit);
            return sourceHit;
        }

        const srcKey = this.canReadSourceIndex(attr) ? this.lock.getSourceByKey(sourceKey) : undefined;
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached && this.canUseSourceIndexHit(mapped, cached)) {
                return this.publishResolved(requestSpec, mapped, parent, cached, attr, { rememberExact: true });
            }
        }

        const localPreferred = this.tryResolveLocalNpm(mapped, parent, attr);
        if (localPreferred) {
            return this.publishResolved(requestSpec, mapped, parent, localPreferred, attr, {
                persistModule: true,
                persistSource: true,
                rememberExact: true,
            });
        }

        const proto = protoOf(mapped);
        if (this.canReadSourceIndex(attr) && proto && proto !== 'file') {
            const lockHit = this.lock.getModule(mapped);
            if (lockHit && this.canUseCachedInfo(lockHit)) {
                return this.publishResolved(requestSpec, mapped, parent, lockHit, attr, {
                    persistSource: true,
                    rememberExact: true,
                });
            }
        }

        if (this.cfg.frozen) {
            throw err(ErrorKind.LockFrozen, `Module not in lock: "${mapped}"`);
        }

        // L3 — dispatch async if handler supports it, else sync
        const info = await this.dispatchAsync(
            mapped,
            parent,
            attr,
            onProgress,
            mapped !== spec && isAbsolute(mapped),
        );
        return this.publishResolved(requestSpec, mapped, parent, info, attr, {
            persistModule: true,
            persistSource: true,
            rememberExact: true,
        });
    }

    private async dispatchAsync(
        spec: string,
        parent: string,
        attr?: Record<string, unknown>,
        onProgress?: ProgressCallback,
        splitAbsoluteSuffix = false,
    ): Promise<ModuleInfo> {
        const proto = protoOf(spec);
        if (proto) {
            if (this.disabled.has(proto)) throw err(ErrorKind.ProtocolDisabled, `Protocol "${proto}:" is disabled`);
            const h = this.handlers.get(proto);
            if (!h) throw err(ErrorKind.ProtocolDisabled, `No handler for protocol "${proto}:"`);
            // Await promise-returning tails so an already-rejected flow promise
            // is marked handled before host rejection tracking runs. A bare
            // `return p` can expose that rejection before async adoption;
            // these paths have no local catch/finally, so `await` preserves
            // propagation while avoiding spurious unhandled-rejection reports.
            return await runAsync(h.resolve(spec, parent, attr, onProgress));
        }
        if (isRelative(spec)) return await this.resolveRelativeAsync(spec, parent, attr, onProgress);
        if (isAbsolute(spec)) return this.resolveAbsolute(spec, attr, splitAbsoluteSuffix);
        return await this.resolveBareAsync(spec, parent, attr, onProgress);
    }

    private async resolveBareAsync(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        if (spec.startsWith('@std/')) return await this.dispatchAsync(`jsr:${spec}`, parent, attr, onProgress);
        if (isBuiltinSpecifier(spec)) return await this.dispatchAsync(`node:${spec}`, parent, attr, onProgress);
        // pack: bare imports are offline edges only (no project dir at run).
        if (protoOf(parent) === 'pack') {
            const handler = this.handlers.get('pack');
            if (handler) return await runAsync(handler.resolve(spec, parent, attr, onProgress));
        }
        const alias = this.resolveAliasCandidates(spec);
        if (alias) {
            const { localPath } = alias;
            return { specPath: localPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
        }
        const npm = this.handlers.get('npm');
        if (npm) {
            return await runAsync(npm.resolve(spec, parent, attr, onProgress));
        }
        throw err(ErrorKind.ModuleNotFound, `Cannot resolve bare specifier: "${spec}"`);
    }

    /**
     * Resolve for inspection only. Use project/lock/store data already on disk;
     * never fetch, install, or materialize a dependency. `require.resolve()`
     * is a synchronous optional-dependency probe, so routing it through normal
     * resolution can turn a local lookup into network I/O and make fallback
     * branches unreachable.
     *
     * A package already present in the local store may resolve even when Node
     * would require a project `node_modules` entry. This keeps the answer
     * consistent with the subsequent cno `require()`; stricter declared-deps
     * policy belongs to node-modules handling. Declared but missing packages
     * are not materialized here: inspection never fetches.
     *
     * Handlers already honor `cachedOnly`, so toggle it for this synchronous
     * call instead of threading another flag through every protocol. Mark the
     * request with `inspect` to keep a store-local inspection result out of
     * normal memo caches; handlers consume only `cjs` and `type` attributes.
     */
    resolveForInspection(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        const prevCachedOnly = this.cfg.cachedOnly;
        this.cfg.cachedOnly = true;
        try {
            return this.resolve(spec, parent, { ...attr, inspect: true });
        } finally {
            this.cfg.cachedOnly = prevCachedOnly;
        }
    }

    // Main resolution — three-level cache

    resolve(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        log.debug('resolver', () => `resolve "${spec}" from "${parent}"`);

        parent = this.normalizeParentRef(parent);
        const requestSpec = spec;
        // Exact cache is keyed by the caller's specifier (see exactResolveKey).
        if (!attr) {
            const hit = this.resolveCache.get(this.exactResolveKey(requestSpec, parent));
            if (hit) return hit;
        }
        // Canonical path before maps/dispatch (drive case + backslashes).
        spec = canonicalizePath(spec);

        // Keep manifest edge specs; import maps can escape pack to live cache.
        if (protoOf(parent) === 'pack') {
            const packedSpec = spec.startsWith('node:') || isBuiltinSpecifier(spec)
                ? (spec.startsWith('node:') ? spec : `node:${spec}`)
                : null;
            const info = packedSpec
                ? this.dispatch(packedSpec, parent, attr)
                : runSync(this.packHandler().resolve(spec, parent, attr));
            return this.publishResolved(requestSpec, spec, parent, info, attr, { rememberExact: true });
        }

        // Import map: skip for relative and absolute paths (they don't need remapping).
        // Uses isAbsolute/isRelative from utils/path to handle Windows drive letters.
        const mapped = (isRelative(spec) || isAbsolute(spec)) ? spec : this.applyImportMap(spec, parent);
        if (mapped !== spec) log.debug('resolver', () => `importmap: "${spec}" → "${mapped}"`);
        const sourceKey = this.sourceCacheKey(mapped, parent, attr);
        const sourceHit = this.sourceInfoCache.get(sourceKey);
        if (sourceHit) {
            this.rememberExact(requestSpec, parent, attr, sourceHit);
            return sourceHit;
        }

        // L1 — source index: (mapped, parent) → specPath we've seen before
        const srcKey = this.canReadSourceIndex(attr) ? this.lock.getSourceByKey(sourceKey) : undefined;
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached && this.canUseSourceIndexHit(mapped, cached)) {
                log.debug('resolver', () => `L1 hit: "${mapped}" → "${srcKey}"`);
                return this.publishResolved(requestSpec, mapped, parent, cached, attr, { rememberExact: true });
            }
        }

        const localPreferred = this.tryResolveLocalNpm(mapped, parent, attr);
        if (localPreferred) {
            return this.publishResolved(requestSpec, mapped, parent, localPreferred, attr, {
                persistModule: true,
                persistSource: true,
                rememberExact: true,
            });
        }

        // L2 — module index: for canonical specifiers, check without dispatching
        const proto = protoOf(mapped);
        if (this.canReadSourceIndex(attr) && proto && proto !== 'file') {
            const lockHit = this.lock.getModule(mapped);
            if (lockHit && this.canUseCachedInfo(lockHit)) {
                log.debug('resolver', () => `L2 hit: "${mapped}"`);
                return this.publishResolved(requestSpec, mapped, parent, lockHit, attr, {
                    persistSource: true,
                    rememberExact: true,
                });
            }
        }

        // L3 — full dispatch (downloads, package.json reads, etc.)
        // --frozen: refuse to resolve anything not already in the lock
        if (this.cfg.frozen) {
            throw err(ErrorKind.LockFrozen,
                `Module not in lock: "${mapped}"\n` +
                `  Run \x1b[36mcts cache <entry>\x1b[0m to update the lock, then retry with --frozen.`
            );
        }
        const info = this.dispatch(mapped, parent, attr, mapped !== spec && isAbsolute(mapped));
        return this.publishResolved(requestSpec, mapped, parent, info, attr, {
            persistModule: true,
            persistSource: true,
            rememberExact: true,
        });
    }

    getInfo(specPath: string): ModuleInfo {
        const runtime = this.runtimeModules.get(specPath);
        if (runtime) return runtime;
        const cached = this.resolvedModules.get(specPath);
        if (cached) return cached;
        const hit = this.lock.getModule(specPath);
        if (hit) {
            this.resolvedModules.set(hit.specPath, hit);
            return hit;
        }
        const proto = protoOf(specPath);
        const h = this.handlers.get(proto);
        if (h) {
            // Pack/ctsview (and future handlers) may carry fileKind/cacheBytecode
            // that cannot be recovered from the materialized path alone.
            const fromHandler = h.getModuleInfo?.(specPath);
            if (fromHandler) {
                this.rememberRuntimeInfo(fromHandler);
                return fromHandler;
            }
            const lp = h.localPath(specPath);
            return {
                specPath,
                localPath: lp,
                format: proto === 'node' ? 'esm' : detectFormat(lp),
                fileKind: guessFileKind(lp),
            };
        }
        return { specPath, localPath: specPath, format: 'esm', fileKind: 'source' };
    }

    flushLock(): void { this.lock.flush(); }
    get lockSize(): number { return this.lock.size; }
    get lockDirty(): number { return this.lock.dirtyCount; }
    get lockPath(): string { return this.lock.path; }

    /** Clear handler caches (for memory cleanup) */
    clearHandlerCaches(): void {
        for (const h of this.handlers.values()) {
            h.clearCache?.();
        }
    }

    /** Clear runtime-only resolution caches while keeping persistent handler state intact. */
    clearRuntimeCaches(): void {
        this.runtimeModules.clear();
        this.packParentsByLocalPath.clear();
        this.resolvedModules.clear();
        this.resolveCache.clear();
        this.sourceInfoCache.clear();
    }

    /** Drain deferred npm lifecycle scripts from the npm handler. */
    drainLifecycleScripts(): LifecycleScriptEntry[] {
        const npm = this.handlers.get('npm');
        if (npm instanceof NpmHandler) return npm.drainLifecycleScripts();
        return [];
    }

    /**
     * Ensure required install-graph packages are in the flat store before
     * soft/hard materialize (scan may never resolve pure package.json edges).
     */
    async ensureInstallGraph(
        seeds: Array<{ name: string; version: string }>,
        onProgress?: ProgressCallback,
    ): Promise<void> {
        const npm = this.handlers.get('npm');
        if (!(npm instanceof NpmHandler) || seeds.length === 0) return;
        await runAsync(npm.ensureInstallGraph(seeds, onProgress));
    }

    resolveBin(name: string, cwd: string): string | null {
        const npm = this.handlers.get('npm');
        if (npm instanceof NpmHandler) return npm.resolveBin(name, cwd);
        return null;
    }

    private dispatch(
        spec: string,
        parent: string,
        attr?: Record<string, unknown>,
        splitAbsoluteSuffix = false,
    ): ModuleInfo {
        const proto = protoOf(spec);
        if (proto) {
            if (this.disabled.has(proto)) throw err(ErrorKind.ProtocolDisabled, `Protocol "${proto}:" is disabled`);
            const h = this.handlers.get(proto);
            if (!h) throw err(ErrorKind.ProtocolDisabled, `No handler for protocol "${proto}:"`);
            return runSync(h.resolve(spec, parent, attr));
        }
        if (isRelative(spec)) return this.resolveRelative(spec, parent, attr);
        if (isAbsolute(spec)) return this.resolveAbsolute(spec, attr, splitAbsoluteSuffix);
        return this.resolveBare(spec, parent, attr);
    }

    private *resolvePackageImportTarget(
        spec: string,
        parent: string,
        attr?: Record<string, unknown>,
        onProgress?: ProgressCallback,
    ): Flow<ModuleInfo> {
        const target = spec.startsWith('@std/') ? `jsr:${spec}`
            : isBuiltinSpecifier(spec) ? `node:${spec}`
            : spec;
        const proto = protoOf(target);
        const handler = this.handlers.get(proto || 'npm');
        if (proto && this.disabled.has(proto)) {
            throw err(ErrorKind.ProtocolDisabled, `Protocol "${proto}:" is disabled`);
        }
        if (!handler) {
            throw err(ErrorKind.ProtocolDisabled,
                proto ? `No handler for protocol "${proto}:"` : `Cannot resolve bare specifier: "${target}"`);
        }
        return yield* handler.resolve(target, parent, attr, onProgress);
    }

    private packHandler(): ProtocolHandler {
        const handler = this.handlers.get('pack');
        if (handler) return handler;
        throw err(ErrorKind.ProtocolDisabled, 'No handler for protocol "pack:"');
    }

    private resolveRelative(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        const pp = protoOf(parent);
        // Delegate to protocol handler for non-file protocols (npm:, jsr:, http:, etc.)
        if (pp && pp !== 'file') {
            const handler = this.handlers.get(pp);
            if (handler) return runSync(handler.resolve(spec, parent, attr));
        }
        let base = parent;
        if (schemeId(parent) === 'file') {
            base = fileUrlToPath(parent);
        } else {
            base = splitLocalSpecifier(base).path;
        }
        // Ensure base is an absolute path for correct relative resolution
        if (!isAbsolute(base)) base = resolvePath(base);
        base = dirname(base);
        const specParts = splitLocalSpecifier(spec);
        const joined = joinPaths(base, specParts.path);
        const localPath = resolveLocalFile(normalizePath(joined));
        const specPath = localPath + specParts.suffix;
        const localNpm = this.canonicalizeLocalNpmFile(localPath, attr);
        if (localNpm && !specParts.suffix) return localNpm;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    private async resolveRelativeAsync(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        const pp = protoOf(parent);
        if (pp && pp !== 'file') {
            const h = this.handlers.get(pp);
            // `return await`: see dispatchAsync. A flow that throws before its
            // first yield hands back an already-rejected promise, and a bare
            // return would let the tracker report it before adoption.
            if (h) return await runAsync(h.resolve(spec, parent, attr, onProgress));
        }
        return this.resolveRelative(spec, parent, attr);
    }

    private resolveAbsolute(
        spec: string,
        attr?: Record<string, unknown>,
        splitAbsoluteSuffix = false,
    ): ModuleInfo {
        const specParts = splitLocalSpecifier(spec, splitAbsoluteSuffix);
        const alias     = this.resolveAliasCandidates(specParts.path);
        const localPath = alias ? alias.localPath : resolveLocalFile(specParts.path);
        const specPath  = localPath + specParts.suffix;
        const localNpm = this.canonicalizeLocalNpmFile(localPath, attr);
        if (localNpm && !specParts.suffix) return localNpm;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    private resolveBare(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        if (spec.startsWith('@std/')) return this.dispatch(`jsr:${spec}`, parent, attr);
        if (isBuiltinSpecifier(spec)) return this.dispatch(`node:${spec}`, parent, attr);
        if (protoOf(parent) === 'pack') {
            const handler = this.handlers.get('pack');
            if (handler) return runSync(handler.resolve(spec, parent, attr));
        }
        const alias = this.resolveAliasCandidates(spec);
        if (alias) {
            const { localPath } = alias;
            return { specPath: localPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
        }
        const npm = this.handlers.get('npm');
        if (npm) return runSync(npm.resolve(spec, parent, attr));
        throw err(ErrorKind.ModuleNotFound, `Cannot resolve bare specifier: "${spec}"`);
    }

    // Import map — precomputed O(1) exact + O(k) prefix

    private applyImportMap(spec: string, parent: string): string {
        const idx = this.importIndex;
        if (!idx) return spec;
        const scopeParent = normalizeImportMapScopeRef(parent);
        for (const [scope, mappings] of idx.scopes) {
            if (!scopeParent.startsWith(scope)) continue;
            const scoped = matchImportMap(spec, mappings);
            if (scoped !== undefined) return scoped;
        }
        return matchImportMap(spec, idx.imports) ?? spec;
    }

    /** Alias candidates in tsconfig order; [spec] when no alias matches. */
    private aliasCandidates(spec: string): string[] {
        for (const e of this.aliasIndex) {
            if (e.wildcard) {
                if (spec === e.prefix || spec.startsWith(e.prefix + '/')) {
                    // Empty prefix ("/*" → "./public/*") also matches real OS
                    // paths. Keep on-disk absolutes; remap short /asset imports.
                    if (e.prefix === '' && isRealAbsolutePath(spec)) return [spec];
                    const rest = spec.slice(e.prefix.length);
                    return e.targets.map(t => t + rest);
                }
            } else if (spec === e.prefix) {
                return [...e.targets];
            }
        }
        return [spec];
    }

    /** First alias candidate that exists on disk, or null when none match. */
    private resolveAliasCandidates(spec: string): { aliased: string; localPath: string } | null {
        const candidates = this.aliasCandidates(spec);
        if (candidates.length === 1 && candidates[0] === spec) return null;
        let lastError: unknown;
        for (const aliased of candidates) {
            try {
                return { aliased, localPath: resolveFile(aliased) };
            } catch (e) {
                lastError = e;
            }
        }
        throw err(ErrorKind.ModuleNotFound,
            `Path alias "${spec}" → ${candidates.map(c => `"${c}"`).join(', ')} does not resolve to an existing file: ${lastError instanceof Error ? lastError.message : lastError}`,
            lastError);
    }

    private tryResolveLocalNpm(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo | null {
        if (!spec || spec[0] === '.' || spec[0] === '/' || spec.startsWith('#')) return null;
        const proto = protoOf(spec);
        if (proto && proto !== 'npm') return null;
        if (spec.startsWith('@std/') || isBuiltinSpecifier(spec)) return null;
        const npm = this.handlers.get('npm');
        if (!(npm instanceof NpmHandler)) return null;
        return npm.tryResolveLocal(spec, parent, attr);
    }

    private canonicalizeLocalNpmFile(localPath: string, attr?: Record<string, unknown>): ModuleInfo | null {
        const npm = this.handlers.get('npm');
        if (!(npm instanceof NpmHandler)) return null;
        return npm.tryResolveLocalFile(localPath, attr);
    }

    private publishResolved(
        requestSpec: string,
        mapped: string,
        parent: string,
        info: ModuleInfo,
        attr?: Record<string, unknown>,
        opts?: {
            persistModule?: boolean;
            persistSource?: boolean;
            rememberExact?: boolean;
        },
    ): ModuleInfo {
        const transient = this.isTransientResolve(attr);
        const sourceKey = this.sourceCacheKey(mapped, parent, attr);
        const canonical = this.toCanonicalInfo(info);
        const resolved = this.materializeRuntimeInfo(canonical, attr);

        // CJS condition/format may differ from ESM identity — mode-aware cache only.
        this.sourceInfoCache.set(sourceKey, resolved);
        this.rememberRuntimeInfo(resolved);

        const cacheLockEntry = protoOf(canonical.specPath) !== 'node';
        // specPath → info must be recoverable by getInfo() even for transient
        // (require) resolves: a local node_modules package gets an `npm:` specPath
        // whose localPath cannot be recovered from the store layout alone, so
        // require()-ing an ESM file there would fail with "Package not in cache".
        // Transient fills only when absent — a real ESM resolve wins (conditions
        // and format may differ) and overwrites.
        if (!transient || !this.resolvedModules.has(canonical.specPath)) {
            this.resolvedModules.set(canonical.specPath, canonical);
        }
        if (!transient) {
            if (cacheLockEntry && opts?.persistModule) this.lock.setModule(canonical);
            if (cacheLockEntry && opts?.persistSource) this.lock.setSourceByKey(sourceKey, canonical.specPath);
            // mainEntry is set only by loadEntry / loadSourceEntry(main), not first resolve —
            // so `cno test` modules keep import.meta.main === false (Deno semantics).
        }

        if (opts?.rememberExact) this.rememberExact(requestSpec, parent, attr, resolved);
        return resolved;
    }

    /** Populate exact-hit cache (caller specifier; no attr). */
    private rememberExact(
        requestSpec: string,
        parent: string,
        attr: Record<string, unknown> | undefined,
        info: ModuleInfo,
    ): void {
        if (attr) return;
        this.resolveCache.set(this.exactResolveKey(requestSpec, parent), info);
    }

    /**
     * In-memory exact-hit key. Relative edges share parentDirKey so dense
     * same-dir graphs do not re-run resolveFile for every `./util.js` importer.
     * Always pass the original request specifier (not post-canonicalize).
     */
    private exactResolveKey(spec: string, parent: string): string {
        if (isRelative(spec)) return `${spec}\0${parentDirKey(parent)}`;
        return `${spec}\0${parent}`;
    }

    private canUseCachedInfo(info: ModuleInfo): boolean {
        return !(this.cfg.persistLock && !this.cfg.ignoreScripts && protoOf(info.specPath) === 'npm');
    }

    private canUseSourceIndexHit(_mapped: string, info: ModuleInfo): boolean {
        return this.canUseCachedInfo(info);
    }

    private sourceCacheKey(spec: string, parent: string, attr?: Record<string, unknown>): string {
        return `${attr?.cjs === true ? 'cjs' : 'esm'}\0${spec}\0${parent}\0${this.attrSignature(attr)}`;
    }

    private canReadSourceIndex(attr?: Record<string, unknown>): boolean {
        return !this.isTransientResolve(attr);
    }

    private isTransientResolve(attr?: Record<string, unknown>): boolean {
        return attr?.cjs === true;
    }

    private normalizeParentRef(parent: string): string {
        const runtime = this.runtimeModules.get(parent);
        if (runtime) return runtime.specPath;
        return canonicalizePath(parent);
    }

    private rememberRuntimeInfo(info: ModuleInfo): void {
        const ref = moduleRef(info);
        if (ref !== info.specPath) this.runtimeModules.set(ref, info);
        if (protoOf(info.specPath) === 'pack') {
            this.packParentsByLocalPath.set(normalizePath(info.localPath), info.specPath);
        }
    }

    private readonly packParentsByLocalPath = new Map<string, string>();

    /** Recover the synthetic parent id for a materialized file inside a pack. */
    packParentRef(localPath: string): string | null {
        return this.packParentsByLocalPath.get(normalizePath(localPath)) ?? null;
    }

    private toCanonicalInfo(info: ModuleInfo): ModuleInfo {
        if (!info.moduleId) return info;
        const { moduleId: _moduleId, ...canonical } = info;
        return canonical;
    }

    private materializeRuntimeInfo(info: ModuleInfo, attr?: Record<string, unknown>): ModuleInfo {
        validateAttrType(info.fileKind, attr, info.specPath);
        const fileKind = applyAttrType(info.fileKind, attr);
        if (fileKind === info.fileKind) return info;
        // Attribute views share the base file's localPath. JscCache is keyed by
        // that path, so a text/bytes/json view must never load source bytecode.
        return {
            ...info,
            fileKind,
            moduleId: moduleViewRef(info.specPath, fileKind),
            cacheBytecode: false,
        };
    }

    private attrSignature(attr?: Record<string, unknown>): string {
        if (!attr) return '';
        const keys: string[] = [];
        for (const key in attr) {
            if (key !== 'cjs' && attr[key] !== undefined) keys.push(key);
        }
        if (!keys.length) return '';
        keys.sort();
        let out = '';
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === undefined) continue;
            if (out) out += ',';
            out += `${key}=${String(attr[key])}`;
        }
        return out;
    }

}
