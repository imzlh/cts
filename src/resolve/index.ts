// resolver.ts — ModuleResolver
//
// Three-level resolution cache:
//   L1  lock.sources["mode\0spec\0parent"] → specPath    (skip dispatch entirely)
//   L2  lock.modules[specPath]       → ModuleInfo  (skip protocol handler)
//   L3  dispatch to protocol handler (download if needed)
//
// lock.modules IS the live in-process cache — no separate runCache needed.
// lock.setModule() writes to both lock.modules and lock.dirtyModules.

import { moduleRef, type RuntimeConfig, type ModuleInfo, type NodeBuiltinResolver, type FileKind, type LifecycleScriptEntry } from '../types';
import type { ProtocolHandler } from './protocols/base';
import type { ProgressCallback } from '../flow';
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
import { normalizePath, joinPaths, isAbsolute, dirname, resolvePath, isRelative, canonicalizePath, resolveFile, hasLeadingSlashDrive, assert, LRU, log } from '../utils';
import { detectFormat } from './pkg';
import { guessFileKind, applyAttrType } from './protocols/base';

const os = import.meta.use('os');
const fs = import.meta.use('fs');

// ---------------------------------------------------------------------------
// protoOf — extract protocol prefix without regex
// Returns '' for relative/absolute paths, 'http' for 'http://...', etc.
// ---------------------------------------------------------------------------

function protoOf(s: string): string {
    const ci = s.indexOf(':');
    if (ci < 2 || ci > 8) return '';           // too short/long for a protocol
    const proto = s.slice(0, ci);
    // Protocols are lowercase alpha only — reject things like 'C:' on Windows
    for (let i = 0; i < proto.length; i++) {
        const c = proto.charCodeAt(i);
        if (c < 97 || c > 122) return '';      // not a-z
    }
    return proto;
}

function splitLocalSpecifier(spec: string): { path: string; suffix: string } {
    const query = spec.indexOf('?');
    const hash = spec.indexOf('#');
    const cut = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash);
    return cut === -1
        ? { path: spec, suffix: '' }
        : { path: spec.slice(0, cut), suffix: spec.slice(cut) };
}

// ---------------------------------------------------------------------------
// Precomputed index structures
// ---------------------------------------------------------------------------

interface ImportMapIndex {
    exact:    Map<string, string>;
    prefixes: Array<[string, string]>; // [prefix/, target] longest-first
}

function buildImportMapIndex(map: Record<string, string>): ImportMapIndex {
    const exact    = new Map<string, string>();
    const prefixes: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(map)) {
        if (k.endsWith('/')) prefixes.push([k, v]);
        else exact.set(k, v);
    }
    prefixes.sort((a, b) => b[0].length - a[0].length);
    return { exact, prefixes };
}

interface PathAliasEntry {
    prefix:   string;
    wildcard: boolean;
    target:   string;
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
        const targets = aliases[alias];
        const target = targets?.[0];
        if (!target) continue;
        const wildcard = alias.endsWith('/*');
        const normalizedTarget = normalizeAliasTarget(target.endsWith('/*') ? target.slice(0,-2) : target, baseUrl);
        entries.push({ prefix: wildcard ? alias.slice(0,-2) : alias, wildcard, target: normalizedTarget });
    }
    return entries;
}

// ---------------------------------------------------------------------------
// ModuleResolver
// ---------------------------------------------------------------------------

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
    /** Stat cache: localPath → { exists, mtime }. Avoids repeated sync fs.stat on hot path. */
    private readonly statCache = new LRU<string, { exists: boolean; mtime: number }>(2048);

    constructor(
        private readonly cfg: RuntimeConfig,
        lockDir?: string,
        lockReadOnly = false,
    ) {
        this.lock        = new LockStore(lockDir ?? os.cwd, lockReadOnly);
        cfg.lockStore = this.lock;
        this.importIndex = cfg.importMap    ? buildImportMapIndex(cfg.importMap) : null;
        this.aliasIndex  = cfg.pathAliases  ? buildAliasIndex(cfg.pathAliases, cfg.baseUrl) : [];
        this.lock.load();

        this.reg(new FileHandler(cfg));
        this.reg(new DataHandler(cfg));
        this.reg(new BlobHandler(cfg));
        this.reg(new NpmHandler(cfg));

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

    // -------------------------------------------------------------------------
    // Async resolution — used by DepScanner during precache for parallel downloads
    // Falls back to sync resolve when no async handler available (file, data, node).
    // -------------------------------------------------------------------------

    async resolveAsync(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        log.debug('resolver', () => `resolveAsync "${spec}" from "${parent}"`);

        parent = this.normalizeParentRef(parent);
        const requestSpec = spec;
        if (spec.includes('\\') || spec[1] === ':') spec = canonicalizePath(spec);

        const mapped = (isRelative(spec) || isAbsolute(spec)) ? spec : this.applyImportMap(spec);
        const sourceKey = this.sourceCacheKey(mapped, parent, attr);
        const sourceHit = this.sourceInfoCache.get(sourceKey);
        if (sourceHit) return sourceHit;

        // L1
        const srcKey = this.canReadSourceIndex(attr) ? this.lock.getSourceByKey(sourceKey) : undefined;
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached && this.canUseSourceIndexHit(mapped, cached)) {
                return this.publishResolved(requestSpec, mapped, parent, cached, attr);
            }
        }

        const localPreferred = this.tryResolveLocalNpm(mapped, parent, attr);
        if (localPreferred) {
            return this.publishResolved(requestSpec, mapped, parent, localPreferred, attr, { persistModule: true, persistSource: true });
        }

        // L2
        const proto = protoOf(mapped);
        if (this.canReadSourceIndex(attr) && proto && proto !== 'file') {
            const lockHit = this.lock.getModule(mapped);
            if (lockHit && this.canUseCachedInfo(lockHit)) {
                return this.publishResolved(requestSpec, mapped, parent, lockHit, attr, { persistSource: true });
            }
        }

        if (this.cfg.frozen) {
            throw err(ErrorKind.LockFrozen, `Module not in lock: "${mapped}"`);
        }

        // L3 — dispatch async if handler supports it, else sync
        const info = await this.dispatchAsync(mapped, parent, attr, onProgress);
        return this.publishResolved(requestSpec, mapped, parent, info, attr, { persistModule: true, persistSource: true });
    }

    private async dispatchAsync(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        const proto = protoOf(spec);
        if (proto) {
            if (this.disabled.has(proto)) throw err(ErrorKind.ProtocolDisabled, `Protocol "${proto}:" is disabled`);
            const h = this.handlers.get(proto);
            if (!h) throw err(ErrorKind.ProtocolDisabled, `No handler for protocol "${proto}:"`);
            return runAsync(h.resolve(spec, parent, attr, onProgress));
        }
        if (isRelative(spec)) return this.resolveRelativeAsync(spec, parent, attr, onProgress);
        if (isAbsolute(spec)) return this.resolveAbsolute(spec, attr);
        return this.resolveBareAsync(spec, parent, attr, onProgress);
    }

    private async resolveBareAsync(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        if (spec.startsWith('@std/')) return this.dispatchAsync(`jsr:${spec}`, parent, attr, onProgress);
        if (isBuiltinSpecifier(spec)) return this.dispatchAsync(`node:${spec}`, parent, attr, onProgress);
        const aliased = this.applyPathAlias(spec);
        if (aliased !== spec) {
            try {
                const localPath = resolveFile(aliased);
                const specPath  = localPath;
                return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
            } catch (e) {
                throw err(ErrorKind.ModuleNotFound, `Path alias "${spec}" → "${aliased}" does not resolve to an existing file: ${e instanceof Error ? e.message : e}`, e);
            }
        }
        const npm = this.handlers.get('npm');
        if (npm) {
            return runAsync(npm.resolve(spec, parent, attr, onProgress));
        }
        throw err(ErrorKind.ModuleNotFound, `Cannot resolve bare specifier: "${spec}"`);
    }

    // -------------------------------------------------------------------------
    // Main resolution — three-level cache
    // -------------------------------------------------------------------------

    resolve(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        log.debug('resolver', () => `resolve "${spec}" from "${parent}"`);

        parent = this.normalizeParentRef(parent);
        const requestSpec = spec;
        // Normalize Windows backslashes to forward slashes and upper-case the
        // drive letter so a case-insensitive volume can't split cache keys.
        // Must happen before import map lookup, protoOf check, and dispatch.
        spec = canonicalizePath(spec);

        // Fast path: exact (spec, parent) seen before — skip import map + L1/L2/dispatch
        if (!attr) {
            const cacheKey = `${spec}\0${parent}`;
            const hit = this.resolveCache.get(cacheKey);
            if (hit) return hit;
        }

        // Import map: skip for relative and absolute paths (they don't need remapping).
        // Uses isAbsolute/isRelative from utils/path to handle Windows drive letters.
        const mapped = (isRelative(spec) || isAbsolute(spec)) ? spec : this.applyImportMap(spec);
        if (mapped !== spec) log.debug('resolver', () => `importmap: "${spec}" → "${mapped}"`);
        const sourceKey = this.sourceCacheKey(mapped, parent, attr);
        const sourceHit = this.sourceInfoCache.get(sourceKey);
        if (sourceHit) return sourceHit;

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
        const info = this.dispatch(mapped, parent, attr);
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
        if (hit && this.isUsableInfo(hit)) {
            this.resolvedModules.set(hit.specPath, hit);
            return hit;
        }
        const proto = protoOf(specPath);
        const h = this.handlers.get(proto);
        if (h) {
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

    flushLock():   void { this.lock.flush(); }
    rewriteLock(): void { this.lock.rewrite(); }
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
        this.resolvedModules.clear();
        this.resolveCache.clear();
        this.sourceInfoCache.clear();
        this.statCache.clear();
    }

    /** Drain deferred npm lifecycle scripts from the npm handler. */
    drainLifecycleScripts(): LifecycleScriptEntry[] {
        const npm = this.handlers.get('npm');
        if (npm instanceof NpmHandler) return npm.drainLifecycleScripts();
        return [];
    }

    resolveBin(name: string, cwd: string): string | null {
        const npm = this.handlers.get('npm');
        if (npm instanceof NpmHandler) return npm.resolveBin(name, cwd);
        return null;
    }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    private dispatch(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        const proto = protoOf(spec);
        if (proto) {
            if (this.disabled.has(proto)) throw err(ErrorKind.ProtocolDisabled, `Protocol "${proto}:" is disabled`);
            const h = this.handlers.get(proto);
            if (!h) throw err(ErrorKind.ProtocolDisabled, `No handler for protocol "${proto}:"`);
            return runSync(h.resolve(spec, parent, attr));
        }
        if (isRelative(spec)) return this.resolveRelative(spec, parent, attr);
        if (isAbsolute(spec)) return this.resolveAbsolute(spec, attr);
        return this.resolveBare(spec, parent, attr);
    }

    private resolveRelative(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        const pp = protoOf(parent);
        // Delegate to protocol handler for non-file protocols (npm:, jsr:, http:, etc.)
        if (pp && pp !== 'file') {
            const handler = this.handlers.get(pp);
            if (handler) return runSync(handler.resolve(spec, parent, attr));
        }
        let base = parent.startsWith('file://') ? parent.slice(7) : parent;
        base = splitLocalSpecifier(base).path;
        // file:///C:/... → /C:/... → strip leading / before drive letter
        if (hasLeadingSlashDrive(base)) base = base.slice(1);
        // Ensure base is an absolute path for correct relative resolution
        if (!isAbsolute(base)) base = resolvePath(base);
        base = dirname(base);
        const specParts = splitLocalSpecifier(spec);
        const joined = joinPaths(base, specParts.path);
        const localPath = resolveFile(normalizePath(joined));
        const specPath = localPath + specParts.suffix;
        const localNpm = this.canonicalizeLocalNpmFile(localPath, attr);
        if (localNpm && !specParts.suffix) return localNpm;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    private async resolveRelativeAsync(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        const pp = protoOf(parent);
        if (pp && pp !== 'file') {
            const h = this.handlers.get(pp);
            if (h) return runAsync(h.resolve(spec, parent, attr, onProgress));
        }
        return this.resolveRelative(spec, parent, attr);
    }

    private resolveAbsolute(spec: string, attr?: Record<string, unknown>): ModuleInfo {
        const specParts = splitLocalSpecifier(spec);
        const aliased   = this.applyPathAlias(specParts.path);
        const localPath = resolveFile(aliased !== specParts.path ? aliased : specParts.path);
        const specPath  = localPath + specParts.suffix;
        const localNpm = this.canonicalizeLocalNpmFile(localPath, attr);
        if (localNpm && !specParts.suffix) return localNpm;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    private resolveBare(spec: string, parent: string, attr?: Record<string, unknown>): ModuleInfo {
        if (spec.startsWith('@std/')) return this.dispatch(`jsr:${spec}`, parent, attr);
        if (isBuiltinSpecifier(spec)) return this.dispatch(`node:${spec}`, parent, attr);
        const aliased = this.applyPathAlias(spec);
        if (aliased !== spec) {
            try {
                const localPath = resolveFile(aliased);
                const specPath  = localPath;
                return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
            } catch (e) {
                throw err(ErrorKind.ModuleNotFound, `Path alias "${spec}" → "${aliased}" does not resolve to an existing file: ${e instanceof Error ? e.message : e}`, e);
            }
        }
        const npm = this.handlers.get('npm');
        if (npm) return runSync(npm.resolve(spec, parent, attr));
        throw err(ErrorKind.ModuleNotFound, `Cannot resolve bare specifier: "${spec}"`);
    }

    // -------------------------------------------------------------------------
    // Import map — precomputed O(1) exact + O(k) prefix
    // -------------------------------------------------------------------------

    private applyImportMap(spec: string): string {
        const idx = this.importIndex;
        if (!idx) return spec;
        const exact = idx.exact.get(spec);
        if (exact !== undefined) return exact;
        for (const [prefix, target] of idx.prefixes) {
            if (spec.startsWith(prefix)) return target + spec.slice(prefix.length);
        }
        // Bare specifier with subpath
        let slash = spec.lastIndexOf('/');
        while (slash > 0) {
            const m = idx.exact.get(spec.slice(0, slash));
            if (m !== undefined) return `${m}/${spec.slice(slash + 1)}`;
            slash = spec.lastIndexOf('/', slash - 1);
        }
        return spec;
    }

    private applyPathAlias(spec: string): string {
        for (const e of this.aliasIndex) {
            if (e.wildcard) {
                if (spec === e.prefix || spec.startsWith(e.prefix + '/'))
                    return e.target + spec.slice(e.prefix.length);
            } else if (spec === e.prefix) {
                return e.target;
            }
        }
        return spec;
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

        // Parent-scoped CJS resolves may intentionally choose different
        // package conditions/format than canonical ESM module identity.
        // Keep those results in the mode-aware source cache only.
        this.sourceInfoCache.set(sourceKey, resolved);
        this.rememberRuntimeInfo(resolved);

        const cacheLockEntry = protoOf(canonical.specPath) !== 'node';
        if (!transient) {
            this.resolvedModules.set(canonical.specPath, canonical);
            if (cacheLockEntry && opts?.persistModule) this.lock.setModule(canonical);
            if (cacheLockEntry && opts?.persistSource) this.lock.setSourceByKey(sourceKey, canonical.specPath);
            if (!this.mainEntry) {
                this.mainEntry = canonical.specPath;
                log.debug('resolver', () => `main: "${canonical.specPath}"`);
            }
        }

        if (opts?.rememberExact && !attr) {
            this.resolveCache.set(`${requestSpec}\0${parent}`, resolved);
        }
        return resolved;
    }

    private canUseCachedInfo(info: ModuleInfo): boolean {
        if (!this.isUsableInfo(info)) return false;
        return !(this.cfg.persistLock && !this.cfg.ignoreScripts && protoOf(info.specPath) === 'npm');
    }

    private canUseSourceIndexHit(mapped: string, info: ModuleInfo): boolean {
        if (!this.canUseCachedInfo(info)) return false;
        const proto = protoOf(mapped);
        if (!proto || proto === 'file') return true;
        const h = this.handlers.get(proto);
        if (!h) return true;
        try {
            return normalizePath(info.localPath) === normalizePath(h.localPath(mapped));
        } catch {
            return false;
        }
    }

    private isUsableInfo(info: ModuleInfo): boolean {
        const proto = protoOf(info.specPath);
        if (proto) {
            const h = this.handlers.get(proto);
            if (h) {
                let expected: string;
                try {
                    expected = normalizePath(h.localPath(info.specPath));
                } catch {
                    return false;
                }
                if (normalizePath(info.localPath) !== expected) return false;
                if (detectFormat(expected) !== info.format) return false;
            }
        }
        return this.localPathExists(info.localPath);
    }

    private localPathExists(localPath: string): boolean {
        // Local files: stat cache avoids repeated sync syscalls on hot path
        const cached = this.statCache.get(localPath);
        if (cached) return cached.exists;
        try {
            const st = fs.stat(localPath);
            this.statCache.set(localPath, { exists: true, mtime: st.mtim.getTime() });
            return true;
        } catch {
            this.statCache.set(localPath, { exists: false, mtime: 0 });
            return false;
        }
    }

    /** Evict a path from the stat cache (e.g. after a load failure). */
    invalidatePath(localPath: string): void {
        this.statCache.delete(localPath);
    }

    /** Get cached mtime for a local path (avoids redundant fs.stat in jsc.load). */
    getCachedMtime(localPath: string): number | undefined {
        return this.statCache.get(localPath)?.mtime;
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
    }

    private toCanonicalInfo(info: ModuleInfo): ModuleInfo {
        if (!info.moduleId) return info;
        const { moduleId: _moduleId, ...canonical } = info;
        return canonical;
    }

    private materializeRuntimeInfo(info: ModuleInfo, attr?: Record<string, unknown>): ModuleInfo {
        const fileKind = applyAttrType(info.fileKind, attr);
        if (fileKind === info.fileKind) return info;
        return {
            ...info,
            fileKind,
            moduleId: `${info.specPath}#cts-view=${fileKind}`,
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
