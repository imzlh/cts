// resolver.ts — ModuleResolver
//
// Three-level resolution cache:
//   L1  lock.sources["mode\0spec\0parent"] → specPath    (skip dispatch entirely)
//   L2  lock.modules[specPath]       → ModuleInfo  (skip protocol handler)
//   L3  dispatch to protocol handler (download if needed)
//
// lock.modules IS the live in-process cache — no separate runCache needed.
// lock.setModule() writes to both lock.modules and lock.dirtyModules.

import type { RuntimeConfig, ModuleInfo, NodeBuiltinResolver, FileKind } from '../types';
import type { ProtocolHandler } from './protocols/base';
import type { ProgressCallback } from '../flow';
import { err, ErrorKind } from '../errors';
import { FileHandler } from './protocols/file';
import { HttpHandler }  from './protocols/http';
import { JsrHandler }   from './protocols/jsr';
import { NpmHandler }   from './protocols/npm';
import { NodeHandler }  from './protocols/node';
import { DataHandler }  from './protocols/data';
import { LockStore }    from '../lock';
import { isBuiltinSpecifier } from './builtins';
import { runAsync, runSync } from '../flow';
import { normalizePath, joinPaths, isAbsolute, dirname, resolvePath, isRelative, canonicalizePath } from '../utils/path';
import { resolveFile } from '../utils/io';
import { detectFormat } from './pkg';
import { guessFileKind, applyAttrType } from './protocols/base';
import { assert } from '../utils/misc';
import { LRU } from '../utils/lru';
import { log } from '../utils/log';

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

function buildAliasIndex(aliases: Record<string, string[]>): PathAliasEntry[] {
    return Object.entries(aliases).flatMap(([alias, targets]) => {
        const target = targets?.[0]; if (!target) return [];
        const wildcard = alias.endsWith('/*');
        return [{ prefix: wildcard ? alias.slice(0,-2) : alias, wildcard,
                  target: target.endsWith('/*') ? target.slice(0,-2) : target }];
    });
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
        this.aliasIndex  = cfg.pathAliases  ? buildAliasIndex(cfg.pathAliases)  : [];
        this.lock.load();

        this.reg(new FileHandler(cfg));
        this.reg(new DataHandler(cfg));
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

    // -------------------------------------------------------------------------
    // Async resolution — used by DepScanner during precache for parallel downloads
    // Falls back to sync resolve when no async handler available (file, data, node).
    // -------------------------------------------------------------------------

    async resolveAsync(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        log.debug('resolver', () => `resolveAsync "${spec}" from "${parent}"`);

        if (spec.includes('\\') || spec[1] === ':') spec = canonicalizePath(spec);

        const mapped = (isRelative(spec) || isAbsolute(spec)) ? spec : this.applyImportMap(spec);
        const sourceKey = this.sourceCacheKey(mapped, parent, attr);
        const transient = this.isTransientResolve(attr);
        const sourceHit = this.sourceInfoCache.get(sourceKey);
        if (sourceHit) return sourceHit;

        // L1
        const srcKey = transient ? undefined : this.lock.getSourceByKey(sourceKey);
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached && this.isUsableInfo(cached)) {
                const fileKind = applyAttrType(cached.fileKind, attr);
                const final = fileKind !== cached.fileKind ? { ...cached, fileKind } : cached;
                this.resolvedModules.set(final.specPath, final);
                this.sourceInfoCache.set(sourceKey, final);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                return final;
            }
        }

        const localPreferred = this.tryResolveLocalNpm(mapped, parent, attr);
        if (localPreferred) {
            return this.rememberResolved(mapped, parent, localPreferred, attr);
        }

        // L2
        const proto = protoOf(mapped);
        if (!transient && proto && proto !== 'file') {
            const lockHit = this.lock.getModule(mapped);
            if (lockHit && this.isUsableInfo(lockHit)) {
                const fileKind = applyAttrType(lockHit.fileKind, attr);
                const final = fileKind !== lockHit.fileKind ? { ...lockHit, fileKind } : lockHit;
                this.resolvedModules.set(final.specPath, final);
                this.lock.setSourceByKey(this.sourceCacheKey(mapped, parent, attr), final.specPath);
                this.sourceInfoCache.set(sourceKey, final);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                return final;
            }
        }

        if (this.cfg.frozen) {
            throw err(ErrorKind.LockFrozen, `Module not in lock: "${mapped}"`);
        }

        // L3 — dispatch async if handler supports it, else sync
        const info = await this.dispatchAsync(mapped, parent, attr, onProgress);
        return this.rememberResolved(mapped, parent, info, attr);
    }

    private async dispatchAsync(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
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

    private async resolveBareAsync(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        if (spec.startsWith('@std/')) return this.dispatchAsync(`jsr:${spec}`, parent, attr, onProgress);
        if (isBuiltinSpecifier(spec)) return this.dispatchAsync(`node:${spec}`, parent, attr, onProgress);
        const aliased = this.applyPathAlias(spec);
        if (aliased !== spec) {
            try {
                const localPath = resolveFile(aliased);
                const specPath  = localPath;
                return { specPath, localPath, format: detectFormat(localPath), fileKind: applyAttrType(guessFileKind(localPath), attr) };
            } catch (e) {
                throw err(ErrorKind.ModuleNotFound, `Path alias "${spec}" → "${aliased}" does not resolve to an existing file: ${e instanceof Error ? e.message : e}`);
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

    resolve(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        log.debug('resolver', () => `resolve "${spec}" from "${parent}"`);

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
        const transient = this.isTransientResolve(attr);
        const sourceHit = this.sourceInfoCache.get(sourceKey);
        if (sourceHit) return sourceHit;

        // L1 — source index: (mapped, parent) → specPath we've seen before
        const srcKey = transient ? undefined : this.lock.getSourceByKey(sourceKey);
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached && this.isUsableInfo(cached)) {
                log.debug('resolver', () => `L1 hit: "${mapped}" → "${srcKey}"`);
                const fileKind = applyAttrType(cached.fileKind, attr);
                const final = fileKind !== cached.fileKind ? { ...cached, fileKind } : cached;
                this.resolvedModules.set(final.specPath, final);
                this.sourceInfoCache.set(sourceKey, final);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                if (!attr) this.resolveCache.set(`${spec}\0${parent}`, final);
                return final;
            }
        }

        const localPreferred = this.tryResolveLocalNpm(mapped, parent, attr);
        if (localPreferred) {
            return this.rememberResolved(mapped, parent, localPreferred, attr);
        }

        // L2 — module index: for canonical specifiers, check without dispatching
        const proto = protoOf(mapped);
        if (!transient && proto && proto !== 'file') {
            const lockHit = this.lock.getModule(mapped);
            if (lockHit && this.isUsableInfo(lockHit)) {
                log.debug('resolver', () => `L2 hit: "${mapped}"`);
                const fileKind = applyAttrType(lockHit.fileKind, attr);
                const final = fileKind !== lockHit.fileKind ? { ...lockHit, fileKind } : lockHit;
                this.resolvedModules.set(final.specPath, final);
                this.lock.setSourceByKey(this.sourceCacheKey(mapped, parent, attr), final.specPath);
                this.sourceInfoCache.set(sourceKey, final);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                if (!attr) this.resolveCache.set(`${spec}\0${parent}`, final);
                return final;
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
        return this.rememberResolved(mapped, parent, info, attr);
    }

    getInfo(specPath: string): ModuleInfo {
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

    /** Clear handler caches (for memory cleanup) */
    clearHandlerCaches(): void {
        for (const h of this.handlers.values()) {
            h.clearCache?.();
        }
    }

    /** Drain pending postinstall scripts from the npm handler. */
    drainPostinstall(): Array<{ name: string; version: string; dir: string; script: string }> {
        const npm = this.handlers.get('npm');
        if (npm instanceof NpmHandler) return npm.drainPostinstall();
        return [];
    }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    private dispatch(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
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

    private resolveRelative(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        const pp = protoOf(parent);
        // Delegate to protocol handler for non-file protocols (npm:, jsr:, http:, etc.)
        if (pp && pp !== 'file') { const h = this.handlers.get(pp); if (h) return runSync(h.resolve(spec, parent, attr)); }
        let base = parent.startsWith('file://') ? parent.slice(7) : parent;
        // file:///C:/... → /C:/... → strip leading / before drive letter
        if (/^\/[a-zA-Z]:/.test(base)) base = base.slice(1);
        // Ensure base is an absolute path for correct relative resolution
        if (!isAbsolute(base)) base = resolvePath(base);
        base = dirname(base);
        const joined = joinPaths(base, spec);
        const localPath = resolveFile(normalizePath(joined));
        const specPath = localPath;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: applyAttrType(guessFileKind(localPath), attr) };
    }

    private async resolveRelativeAsync(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        const pp = protoOf(parent);
        if (pp && pp !== 'file') {
            const h = this.handlers.get(pp);
            if (h) return runAsync(h.resolve(spec, parent, attr, onProgress));
        }
        return this.resolveRelative(spec, parent, attr);
    }

    private resolveAbsolute(spec: string, attr?: Record<string, any>): ModuleInfo {
        const aliased   = this.applyPathAlias(spec);
        const localPath = resolveFile(aliased !== spec ? aliased : spec);
        const specPath  = localPath;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: applyAttrType(guessFileKind(localPath), attr) };
    }

    private resolveBare(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        if (spec.startsWith('@std/')) return this.dispatch(`jsr:${spec}`, parent, attr);
        if (isBuiltinSpecifier(spec)) return this.dispatch(`node:${spec}`, parent, attr);
        const aliased = this.applyPathAlias(spec);
        if (aliased !== spec) {
            try {
                const localPath = resolveFile(aliased);
                const specPath  = localPath;
                return { specPath, localPath, format: detectFormat(localPath), fileKind: applyAttrType(guessFileKind(localPath), attr) };
            } catch (e) {
                throw err(ErrorKind.ModuleNotFound, `Path alias "${spec}" → "${aliased}" does not resolve to an existing file: ${e instanceof Error ? e.message : e}`);
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
        const parts = spec.split('/');
        for (let i = parts.length - 1; i > 0; i--) {
            const base = parts.slice(0, i).join('/');
            const m    = idx.exact.get(base);
            if (m !== undefined) return `${m}/${parts.slice(i).join('/')}`;
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

    private tryResolveLocalNpm(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo | null {
        if (!spec || spec[0] === '.' || spec[0] === '/' || spec.startsWith('#')) return null;
        const proto = protoOf(spec);
        if (proto && proto !== 'npm') return null;
        if (spec.startsWith('@std/') || isBuiltinSpecifier(spec)) return null;
        const npm = this.handlers.get('npm');
        if (!(npm instanceof NpmHandler)) return null;
        try {
            return npm.tryResolveLocal(spec, parent, attr);
        } catch {
            return null;
        }
    }

    private rememberResolved(mapped: string, parent: string, info: ModuleInfo, attr?: Record<string, any>): ModuleInfo {
        this.resolvedModules.set(info.specPath, info);
        const sourceKey = this.sourceCacheKey(mapped, parent, attr);
        this.sourceInfoCache.set(sourceKey, info);
        if (!this.isTransientResolve(attr)) {
            this.lock.setModule(info);
            this.lock.setSourceByKey(sourceKey, info.specPath);
        }
        if (!attr) this.resolveCache.set(`${mapped}\0${parent}`, info);
        if (!this.mainEntry) {
            this.mainEntry = info.specPath;
            log.debug('resolver', () => `main: "${info.specPath}"`);
        }
        return info;
    }

    private isUsableInfo(info: ModuleInfo): boolean {
        const proto = protoOf(info.specPath);
        // npm/jsr/http/data packages live in cacheDir or are runtime-provided — always usable
        if (proto && proto !== 'file') return true;
        // Local files: stat cache avoids repeated sync syscalls on hot path
        const cached = this.statCache.get(info.localPath);
        if (cached) return cached.exists;
        try {
            const st = fs.stat(info.localPath);
            this.statCache.set(info.localPath, { exists: true, mtime: st.mtim.getTime() });
            return true;
        } catch {
            this.statCache.set(info.localPath, { exists: false, mtime: 0 });
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

    private sourceCacheKey(spec: string, parent: string, attr?: Record<string, any>): string {
        return `${attr?.cjs === true ? 'cjs' : 'esm'}\0${spec}\0${parent}`;
    }

    private isTransientResolve(attr?: Record<string, any>): boolean {
        return attr?.cjs === true;
    }

}
