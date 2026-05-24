// resolver.ts — ModuleResolver
//
// Three-level resolution cache:
//   L1  lock.sources["spec\0parent"] → specPath    (skip dispatch entirely)
//   L2  lock.modules[specPath]       → ModuleInfo  (skip protocol handler)
//   L3  dispatch to protocol handler (download if needed)
//
// lock.modules IS the live in-process cache — no separate runCache needed.
// lock.setModule() writes to both lock.modules and lock.dirtyModules.

import type { RuntimeConfig, ModuleInfo, NodeBuiltinResolver, FileKind } from './types';
import type { ProtocolHandler } from './protocol/base';
import type { ProgressCallback } from '@cnojs/http';
import { err, ErrorKind } from './errors';
import { FileHandler } from './protocol/file';
import { HttpHandler }  from './protocol/http';
import { JsrHandler }   from './protocol/jsr';
import { NpmHandler }   from './protocol/npm';
import { NodeHandler }  from './protocol/node';
import { DataHandler }  from './protocol/data';
import { LockStore }    from './lock';
import { normalizePath, joinPaths, isAbsolute, dirname, resolvePath } from './utils/path';
import { resolveFile } from './utils/io';
import { detectFormat } from './pkg';
import { guessFileKind, applyAttrType } from './protocol/base';
import { assert } from './utils/misc';
import { log } from './utils/log';
import { os } from './utils/index';

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
    private readonly fileKindCache = new Map<string, FileKind>();

    constructor(
        private readonly cfg: RuntimeConfig,
        lockDir?: string,
        lockReadOnly = false,
    ) {
        this.lock        = new LockStore(lockDir ?? os.cwd, lockReadOnly);
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

        const mapped = (spec[0] === '.' || spec[0] === '/') ? spec : this.applyImportMap(spec);

        // L1
        const srcKey = this.lock.getSource(mapped, parent);
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached) {
                const fileKind = applyAttrType(cached.fileKind, attr);
                const final = fileKind !== cached.fileKind ? { ...cached, fileKind } : cached;
                this.fileKindCache.set(final.specPath, final.fileKind);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                return final;
            }
        }

        // L2
        const proto = protoOf(mapped);
        if (proto && proto !== 'file') {
            const lockHit = this.lock.getModule(mapped);
            if (lockHit) {
                const fileKind = applyAttrType(lockHit.fileKind, attr);
                const final = fileKind !== lockHit.fileKind ? { ...lockHit, fileKind } : lockHit;
                this.fileKindCache.set(final.specPath, final.fileKind);
                this.lock.setSource(mapped, parent, final.specPath);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                return final;
            }
        }

        if (this.cfg.frozen) {
            throw err(ErrorKind.LockFrozen, `Module not in lock: "${mapped}"`);
        }

        // L3 — dispatch async if handler supports it, else sync
        const info = await this.dispatchAsync(mapped, parent, attr, onProgress);
        this.fileKindCache.set(info.specPath, info.fileKind);

        this.lock.setModule(info);
        this.lock.setSource(mapped, parent, info.specPath);
        if (!this.mainEntry) { this.mainEntry = info.specPath; log.debug('resolver', () => `main: "${info.specPath}"`); }
        return info;
    }

    private async dispatchAsync(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        const proto = protoOf(spec);
        if (proto) {
            if (this.disabled.has(proto)) throw err(ErrorKind.ProtocolDisabled, `Protocol "${proto}:" is disabled`);
            const h = this.handlers.get(proto);
            if (!h) throw err(ErrorKind.ProtocolDisabled, `No handler for protocol "${proto}:"`);
            if (h.resolveAsync) return h.resolveAsync(spec, parent, attr, onProgress);
            return h.resolve(spec, parent, attr);
        }
        if (spec.startsWith('./') || spec.startsWith('../')) return this.resolveRelative(spec, parent, attr);
        if (isAbsolute(spec)) return this.resolveAbsolute(spec, attr);
        return this.resolveBareAsync(spec, parent, attr, onProgress);
    }

    private async resolveBareAsync(spec: string, parent: string, attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        if (spec.startsWith('@std/')) return this.dispatchAsync(`jsr:${spec}`, parent, attr, onProgress);
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
            if (npm.resolveAsync) return npm.resolveAsync(spec, parent, attr, onProgress);
            return npm.resolve(spec, parent, attr);
        }
        throw err(ErrorKind.ModuleNotFound, `Cannot resolve bare specifier: "${spec}"`);
    }

    // -------------------------------------------------------------------------
    // Main resolution — three-level cache
    // -------------------------------------------------------------------------

    resolve(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        log.debug('resolver', () => `resolve "${spec}" from "${parent}"`);

        // Import map applied first; skip for obvious relative/absolute paths
        const mapped = (spec[0] === '.' || spec[0] === '/') ? spec : this.applyImportMap(spec);
        if (mapped !== spec) log.debug('resolver', () => `importmap: "${spec}" → "${mapped}"`);

        // L1 — source index: (mapped, parent) → specPath we've seen before
        const srcKey = this.lock.getSource(mapped, parent);
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached) {
                log.debug('resolver', () => `L1 hit: "${mapped}" → "${srcKey}"`);
                const fileKind = applyAttrType(cached.fileKind, attr);
                const final = fileKind !== cached.fileKind ? { ...cached, fileKind } : cached;
                this.fileKindCache.set(final.specPath, final.fileKind);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                return final;
            }
        }

        // L2 — module index: for canonical specifiers, check without dispatching
        const proto = protoOf(mapped);
        if (proto && proto !== 'file') {
            const lockHit = this.lock.getModule(mapped);
            if (lockHit) {
                log.debug('resolver', () => `L2 hit: "${mapped}"`);
                const fileKind = applyAttrType(lockHit.fileKind, attr);
                const final = fileKind !== lockHit.fileKind ? { ...lockHit, fileKind } : lockHit;
                this.fileKindCache.set(final.specPath, final.fileKind);
                this.lock.setSource(mapped, parent, final.specPath);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                return final;
            }
        }

        // L3 — full dispatch (downloads, package.json reads, etc.)
        // --frozen: refuse to resolve anything not already in the lock
        if (this.cfg.frozen) {
            throw err(ErrorKind.LockFrozen,
                `Module not in lock: "${mapped}"\n` +
                `  Run [36mcts cache <entry>[0m to update the lock, then retry with --frozen.`
            );
        }
        const info = this.dispatch(mapped, parent, attr);
        this.fileKindCache.set(info.specPath, info.fileKind);

        this.lock.setModule(info);
        this.lock.setSource(mapped, parent, info.specPath);
        if (!this.mainEntry) { this.mainEntry = info.specPath; log.debug('resolver', () => `main: "${info.specPath}"`); }
        return info;
    }

    getInfo(specPath: string): ModuleInfo {
        const cachedKind = this.fileKindCache.get(specPath);
        const hit = this.lock.getModule(specPath);
        if (hit) {
            if (cachedKind && cachedKind !== hit.fileKind) return { ...hit, fileKind: cachedKind };
            return hit;
        }
        if (cachedKind) return { specPath, localPath: specPath, format: 'esm', fileKind: cachedKind };
        const h = this.handlers.get(protoOf(specPath));
        if (h) return { specPath, localPath: h.localPath(specPath), format: 'esm', fileKind: 'source' };
        return { specPath, localPath: specPath, format: 'esm', fileKind: 'source' };
    }

    flushLock():   void { this.lock.flush(); }
    rewriteLock(): void { this.lock.rewrite(); }
    get lockSize(): number { return this.lock.size; }
    get lockDirty(): number { return this.lock.dirtyCount; }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    private dispatch(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        const proto = protoOf(spec);
        if (proto) {
            if (this.disabled.has(proto)) throw err(ErrorKind.ProtocolDisabled, `Protocol "${proto}:" is disabled`);
            const h = this.handlers.get(proto);
            if (!h) throw err(ErrorKind.ProtocolDisabled, `No handler for protocol "${proto}:"`);
            return h.resolve(spec, parent, attr);
        }
        if (spec.startsWith('./') || spec.startsWith('../')) return this.resolveRelative(spec, parent, attr);
        if (isAbsolute(spec)) return this.resolveAbsolute(spec, attr);
        return this.resolveBare(spec, parent, attr);
    }

    private resolveRelative(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        const pp = protoOf(parent);
        // Delegate to protocol handler for non-file protocols (npm:, jsr:, http:, etc.)
        if (pp && pp !== 'file') { const h = this.handlers.get(pp); if (h) return h.resolve(spec, parent, attr); }
        let base = parent.startsWith('file://') ? parent.slice(7) : parent;
        // Ensure base is an absolute path for correct relative resolution
        if (!isAbsolute(base)) base = resolvePath(base);
        base = dirname(base);
        const joined = joinPaths(base, spec);
        const localPath = resolveFile(normalizePath(joined));
        const specPath = localPath;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: applyAttrType(guessFileKind(localPath), attr) };
    }

    private resolveAbsolute(spec: string, attr?: Record<string, any>): ModuleInfo {
        const aliased   = this.applyPathAlias(spec);
        const localPath = resolveFile(aliased !== spec ? aliased : spec);
        const specPath  = localPath;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: applyAttrType(guessFileKind(localPath), attr) };
    }

    private resolveBare(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        if (spec.startsWith('@std/')) return this.dispatch(`jsr:${spec}`, parent, attr);
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
        if (npm) return npm.resolve(spec, parent, attr);
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
}
