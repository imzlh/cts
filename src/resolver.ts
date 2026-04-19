// resolver.ts — ModuleResolver
//
// Three-level resolution cache:
//   L1  lock.sources["spec\0parent"] → specPath    (skip dispatch entirely)
//   L2  lock.modules[specPath]       → ModuleInfo  (skip protocol handler)
//   L3  dispatch to protocol handler (download if needed)
//
// lock.modules IS the live in-process cache — no separate runCache needed.
// lock.setModule() writes to both lock.modules and lock.dirtyModules.

import type { RuntimeConfig, ModuleInfo, NodeBuiltinResolver } from './types';
import type { ProtocolHandler } from './protocol/base';
import { FileHandler } from './protocol/file';
import { HttpHandler }  from './protocol/http';
import { JsrHandler }   from './protocol/jsr';
import { NpmHandler }   from './protocol/npm';
import { NodeHandler }  from './protocol/node';
import { DataHandler }  from './protocol/data';
import { LockStore }    from './lock';
import { normalizePath, joinPaths, isAbsolute, dirname } from './utils/path';
import { resolveFile } from './utils/io';
import { detectFormat } from './pkg';
import { guessFileKind } from './protocol/base';
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
    private readonly importIndex:  ImportMapIndex | null;
    private readonly aliasIndex:   PathAliasEntry[];
    private mainEntry = '';

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
    // Main resolution — three-level cache
    // -------------------------------------------------------------------------

    resolve(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        log.debug('resolver', () => `resolve "${spec}" from "${parent}"`);

        // Import map applied first; skip for obvious relative/absolute paths
        const mapped = (spec[0] === '.' || spec[0] === '/') ? spec : this.applyImportMap(spec);
        if (mapped !== spec) log.debug('resolver', () => `importmap: "${spec}" → "${mapped}"`);

        const hint = attr?.type as string | undefined;

        // L1 — source index: (mapped, parent) → specPath we've seen before
        const srcKey = this.lock.getSource(mapped, parent);
        if (srcKey) {
            const cached = this.lock.getModule(srcKey);
            if (cached) {
                log.debug('resolver', () => `L1 hit: "${mapped}" → "${srcKey}"`);
                const specPath = hint ? `${cached.specPath}?${hint}` : cached.specPath;
                const final = specPath !== cached.specPath ? { ...cached, specPath } : cached;
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
                const specPath = hint ? `${lockHit.specPath}?${hint}` : lockHit.specPath;
                const final = specPath !== lockHit.specPath ? { ...lockHit, specPath } : lockHit;
                this.lock.setSource(mapped, parent, final.specPath);
                if (!this.mainEntry) this.mainEntry = final.specPath;
                return final;
            }
        }

        // L3 — full dispatch (downloads, package.json reads, etc.)
        // --frozen: refuse to resolve anything not already in the lock
        if (this.cfg.frozen) {
            throw new Error(
                `Module not in lock: "${mapped}"\n` +
                `  Run [36mcts cache <entry>[0m to update the lock, then retry with --frozen.`
            );
        }
        const info     = this.dispatch(mapped, parent, attr);
        const specPath = hint ? `${info.specPath}?${hint}` : info.specPath;
        const final: ModuleInfo = specPath !== info.specPath ? { ...info, specPath } : info;

        this.lock.setModule(final);
        this.lock.setSource(mapped, parent, final.specPath);
        if (!this.mainEntry) { this.mainEntry = final.specPath; log.debug('resolver', () => `main: "${final.specPath}"`); }
        return final;
    }

    getInfo(specPath: string): ModuleInfo {
        const base = specPath.includes('?') ? specPath.slice(0, specPath.indexOf('?')) : specPath;
        const hit  = this.lock.getModule(specPath) ?? this.lock.getModule(base);
        if (hit) return specPath !== hit.specPath ? { ...hit, specPath } : hit;
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
            if (this.disabled.has(proto)) throw new Error(`Protocol "${proto}:" is disabled`);
            const h = this.handlers.get(proto);
            if (!h) throw new Error(`No handler for protocol "${proto}:"`);
            return h.resolve(spec, parent, attr);
        }
        if (spec.startsWith('./') || spec.startsWith('../')) return this.resolveRelative(spec, parent, attr);
        if (isAbsolute(spec)) return this.resolveAbsolute(spec);
        return this.resolveBare(spec, parent, attr);
    }

    private resolveRelative(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        const pp = protoOf(parent);
        if (pp) { const h = this.handlers.get(pp); if (h) return h.resolve(spec, parent, attr); }
        let base = parent.startsWith('file://') ? parent.slice(7) : parent;
        if (!base.startsWith('/')) base = dirname(base);
        else base = dirname(base);
        const joined = base + '/' + spec;
        const localPath = resolveFile(normalizePath(joined));
        const specPath = localPath;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    private resolveAbsolute(spec: string): ModuleInfo {
        const aliased   = this.applyPathAlias(spec);
        const localPath = resolveFile(aliased !== spec ? aliased : spec);
        const specPath  = localPath;
        return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    private resolveBare(spec: string, parent: string, attr?: Record<string, any>): ModuleInfo {
        if (spec.startsWith('@std/')) return this.dispatch(`jsr:${spec}`, parent, attr);
        const aliased = this.applyPathAlias(spec);
        if (aliased !== spec) {
            try {
                const localPath = resolveFile(aliased);
                const specPath  = localPath;
                return { specPath, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
            } catch {}
        }
        const npm = this.handlers.get('npm');
        if (npm) return npm.resolve(spec, parent, attr);
        throw new Error(`Cannot resolve bare specifier: "${spec}"`);
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
