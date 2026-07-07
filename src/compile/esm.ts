// compile/esm.ts — ESM compilation engine
//
// Responsibilities:
//   - Compile ESM source via engine.Module
//   - ESM module cache (esmCache) + circular dependency detection
//   - specPath dedup (QuickJS does not cache dynamic import() results)
//   - Load special types: binary, text

import { moduleRef, type RuntimeConfig, type ModuleInfo } from '../types';
import { Transformer } from '../source/transform';
import { JscCache, isRemote } from '../source/cache';
import { readText, log } from '../utils';
import { err, ErrorKind } from '../errors';
import type { OxcTranspiler } from '../oxc';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

function metaLang(meta: Record<string, unknown>): string | undefined {
    return typeof meta.lang === 'string' ? meta.lang : undefined;
}

function isTransformSourcePath(path: string): boolean {
    const length = path.length;
    if (length < 3) return false;
    const last = path.charCodeAt(length - 1);
    if (last === 115) {
        return path.charCodeAt(length - 2) === 116 && path.charCodeAt(length - 3) === 46;
    }
    if (last !== 120 || length < 4) return false;
    const prev = path.charCodeAt(length - 2);
    if (prev !== 115) return false;
    const mid = path.charCodeAt(length - 3);
    return (mid === 116 || mid === 106) && path.charCodeAt(length - 4) === 46;
}

function isCompiledSourcePath(path: string): boolean {
    const length = path.length;
    if (length < 3 || path.charCodeAt(length - 1) !== 115 || path.charCodeAt(length - 2) !== 106) {
        return false;
    }
    const dot = path.charCodeAt(length - 3);
    return dot === 46 || (length >= 4 && dot === 109 && path.charCodeAt(length - 4) === 46);
}

export class EsmCompiler {
    private readonly esmCache    = new Map<string, CModuleEngine.Module>();
    private readonly esmLoading  = new Set<string>();
    readonly transformer: Transformer;
    readonly jsc: JscCache;

    constructor(private readonly cfg: RuntimeConfig) {
        this.jsc = new JscCache(cfg.cacheDir);
        this.transformer = new Transformer({
            sourceMaps: true,
            jsxPragma: cfg.jsxPragma,
            jsxFragmentPragma: cfg.jsxFragmentPragma,
        });
    }

    setOxc(oxc: OxcTranspiler): void {
        this.transformer.setOxc(oxc);
    }

    // -------------------------------------------------------------------------
    // Public: load a module from its ModuleInfo (format-agnostic dispatch)
    // -------------------------------------------------------------------------

    load(info: ModuleInfo, meta: Record<string, unknown> = {}, resolveMtime?: (p: string) => number | undefined): CModuleEngine.Module {
        log.debug('loader', () => `load ${info.specPath} kind=${info.fileKind} format=${info.format}`);
        log.debug('loader', () => `alias: ${info.specPath} -> ${info.localPath}`);
        switch (info.fileKind) {
            case 'binary': return this.loadBytes(info);
            case 'text':   return this.loadText(info);
            case 'json':   return this.loadEsm(info, meta, resolveMtime);
            case 'wasm':   return this.loadEsm(info, meta, resolveMtime); // WASM dispatched by compile/index.ts
        }
        return this.loadEsm(info, meta, resolveMtime);
    }

    loadSource(code: string, info: ModuleInfo, meta: Record<string, unknown> = {}): CModuleEngine.Module {
        log.debug('loader', () => `loadSource ${info.specPath} kind=${info.fileKind} format=${info.format}`);
        if (info.fileKind === 'text') return this.loadTextSource(code, info);
        return this.loadEsmSource(code, info, meta);
    }

    /** Store a module in esmCache (for CJS bridge results that need strong ref). */
    setCache(info: ModuleInfo, mod: CModuleEngine.Module): void {
        this.esmCache.set(this.cacheKey(info), mod);
    }

    // -------------------------------------------------------------------------
    // ESM loading
    // -------------------------------------------------------------------------

    /** Compile ESM source code, wrapping SyntaxError with file context. */
    compileEsm(code: string, specPath: string, localPath: string): CModuleEngine.Module {
        try {
            return new engine.Module(code, specPath);
        } catch (e) {
            if (e instanceof SyntaxError) {
                const ne = err(ErrorKind.SyntaxError,
                    `Syntax error in ${localPath}: ${e.message}`, e);
                ne.cause = { source: e, code, path: localPath };
                throw ne;
            }
            throw e;
        }
    }

    private loadEsm(info: ModuleInfo, meta: Record<string, unknown>, resolveMtime?: (p: string) => number | undefined): CModuleEngine.Module {
        const cacheKey = this.cacheKey(info);
        const hit = this.esmCache.get(cacheKey);
        if (hit) {
            if (meta.main !== undefined) Reflect.set(hit.meta, 'main', meta.main);
            return hit;
        }

        // Circular dependency guard
        if (this.esmLoading.has(cacheKey)) {
            log.debug('loader', () => `cycle: ${info.specPath} -- returning placeholder`);
            const placeholder = engine.Module.create(moduleRef(info));
            this.esmCache.set(cacheKey, placeholder);
            return placeholder;
        }

        const remote = isRemote(info.specPath);
        const needsTransform = !remote && isTransformSourcePath(info.localPath);
        const needsCompile  = !remote && !needsTransform && isCompiledSourcePath(info.localPath);
        const cacheable = this.cfg.enableCache !== false && (remote || needsTransform || needsCompile);

        // L1: JSC bytecode cache (in-memory from precompile, or on-disk .jsc)
        if (cacheable) {
            const cached = this.jsc.load(info.localPath, remote, resolveMtime?.(info.localPath));
            if (cached) {
                Object.assign(cached.meta, meta);
                this.esmCache.set(cacheKey, cached);
                return cached;
            }
        }

        // L2: read + transform + compile on main thread
        this.esmLoading.add(cacheKey);
        const text = readText(info.localPath);
        const code = this.transformer.transform(text, info.localPath, metaLang(meta), moduleRef(info));
        let mod: CModuleEngine.Module;
        try {
            mod = this.compileEsm(code, moduleRef(info), info.localPath);
        } catch (e) {
            this.esmLoading.delete(cacheKey);
            this.esmCache.delete(cacheKey);
            throw e;
        }
        this.esmLoading.delete(cacheKey);

        // Populate placeholder if one was created during circular resolution
        const cached = this.esmCache.get(cacheKey);
        if (cached && cached !== mod) {
            const ns = mod.namespace;
            for (const key of Object.keys(ns)) {
                this.exportPlaceholderBinding(cached, key, ns[key]);
            }
            // if no default defined, try to export full namespace
            // if (!('default' in ns)) cached.export('default', Object(ns));
            log.debug('loader', () => `populated ESM placeholder: ${info.specPath} (${Object.keys(ns).length} exports)`);
            return cached;
        }

        if (cacheable) {
            if (remote) this.jsc.persist(info.localPath, mod);
            else        this.jsc.persistLocal(info.localPath, mod);
        }

        Object.assign(mod.meta, meta);
        this.esmCache.set(cacheKey, mod);
        return mod;
    }

    private exportPlaceholderBinding(mod: CModuleEngine.Module, key: string, value: unknown): void {
        try {
            mod.export(key, value);
        } catch {
            // Circular placeholders may already contain a binding with this name.
        }
    }

    loadEsmSource(code: string, info: ModuleInfo, meta: Record<string, unknown>): CModuleEngine.Module {
        const cacheKey = this.cacheKey(info);
        const hit = this.esmCache.get(cacheKey);
        if (hit) {
            if (meta.main !== undefined) Reflect.set(hit.meta, 'main', meta.main);
            return hit;
        }
        const transformed = this.transformer.transform(code, info.localPath, metaLang(meta), moduleRef(info));
        const mod = this.compileEsm(transformed, moduleRef(info), info.localPath);
        Object.assign(mod.meta, meta);
        this.esmCache.set(cacheKey, mod);
        return mod;
    }

    // -------------------------------------------------------------------------
    // Special file types
    // -------------------------------------------------------------------------

    private loadBytes(info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(moduleRef(info));
        mod.export('default', new Uint8Array(fs.readFile(info.localPath)));
        return mod;
    }

    private loadText(info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(moduleRef(info));
        mod.export('default', readText(info.localPath));
        return mod;
    }

    private loadTextSource(code: string, info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(moduleRef(info));
        mod.export('default', code);
        return mod;
    }

    // -------------------------------------------------------------------------
    // Cache management
    // -------------------------------------------------------------------------

    clearLoadedModules(): void {
        this.esmCache.clear();
    }

    hasPendingLoads(): boolean {
        return this.esmLoading.size > 0;
    }

    private cacheKey(info: ModuleInfo): string {
        return moduleRef(info);
    }
}
