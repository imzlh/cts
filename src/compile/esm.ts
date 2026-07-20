import { moduleRef, type RuntimeConfig, type ModuleInfo } from '../types';
import { Transformer } from '../source/transform';
import { JscCache, isRemote, isFileBackedPath } from '../source/cache';
import { readText, readBytes, log } from '../utils';
import { err, ErrorKind } from '../errors';
import type { OxcTranspiler } from '../oxc';

const engine = import.meta.use('engine');

function metaLang(meta: Record<string, unknown>): string | undefined {
    return typeof meta.lang === 'string' ? meta.lang : undefined;
}

/** .ts / .mts / .cts / .tsx / .jsx — extension only (works for pack:/name.ts keys). */
function isTransformSourcePath(path: string): boolean {
    const length = sourcePathLength(path);
    if (length < 3) return false;
    const last = path.charCodeAt(length - 1);
    if (last === 115) {
        if (path.charCodeAt(length - 2) !== 116) return false;
        const third = path.charCodeAt(length - 3);
        if (third === 46) return true;
        // .mts / .cts
        return length >= 4 &&
            (third === 109 || third === 99) &&
            path.charCodeAt(length - 4) === 46;
    }
    if (last !== 120 || length < 4) return false;
    const prev = path.charCodeAt(length - 2);
    if (prev !== 115) return false;
    const mid = path.charCodeAt(length - 3);
    return (mid === 116 || mid === 106) && path.charCodeAt(length - 4) === 46;
}

/** .js / .mjs — extension only. */
function isCompiledSourcePath(path: string): boolean {
    const length = sourcePathLength(path);
    if (length < 3 || path.charCodeAt(length - 1) !== 115 || path.charCodeAt(length - 2) !== 106) {
        return false;
    }
    const dot = path.charCodeAt(length - 3);
    return dot === 46 || (length >= 4 && dot === 109 && path.charCodeAt(length - 4) === 46);
}

function sourcePathLength(path: string): number {
    if (!path.startsWith('pack:')) return path.length;
    const query = path.indexOf('?');
    const hash = path.indexOf('#');
    if (query === -1) return hash === -1 ? path.length : hash;
    return hash === -1 ? query : Math.min(query, hash);
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

    setOxcLoader(loader: () => OxcTranspiler | null): void {
        this.transformer.setOxcLoader(loader);
    }

    // Public: load a module from its ModuleInfo (format-agnostic dispatch)

    load(info: ModuleInfo, meta: Record<string, unknown> = {}, resolveMtime?: (p: string) => number | undefined): CModuleEngine.Module {
        log.debug('loader', () =>
            `load ${info.specPath} → ${info.localPath} kind=${info.fileKind} format=${info.format}`);
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

    /** Compile ESM source code, wrapping SyntaxError with file context. */
    compileEsm(code: string | Uint8Array, specPath: string, localPath: string): CModuleEngine.Module {
        try {
            return new engine.Module(code, specPath);
        } catch (e) {
            // Invalid UTF-8 bytes: retry via decodeString before real syntax error.
            if (typeof code !== 'string' && e instanceof SyntaxError) {
                try {
                    return new engine.Module(engine.decodeString(code), specPath);
                } catch (e2) {
                    throw this.wrapSyntaxError(e2, code, localPath);
                }
            }
            throw this.wrapSyntaxError(e, code, localPath);
        }
    }

    private wrapSyntaxError(e: unknown, code: string | Uint8Array, localPath: string): unknown {
        if (!(e instanceof SyntaxError)) return e;
        const ne = err(ErrorKind.SyntaxError, `Syntax error in ${localPath}: ${e.message}`, e);
        // cause.code feeds the fail-<hash>.log code frame — decode bytes
        // here (error path only) so reportSyntax() always sees a string.
        const text = typeof code === 'string' ? code : engine.decodeString(code);
        ne.cause = { source: e, code: text, path: localPath };
        return ne;
    }

    private loadEsm(info: ModuleInfo, meta: Record<string, unknown>, resolveMtime?: (p: string) => number | undefined): CModuleEngine.Module {
        const moduleId = moduleRef(info);
        const cacheKey = moduleId;
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
        const fileBacked = isFileBackedPath(info.localPath);
        // Extension policy (works for pack:/name.ts keys, not only host paths).
        const needsTransform = isTransformSourcePath(info.localPath);
        const needsCompile = !needsTransform && isCompiledSourcePath(info.localPath);
        // sourceOnly: no cache. L1 if remote/pack/local candidate; L2 only if file-backed.
        const allowCache = info.cacheBytecode !== false && this.cfg.enableCache !== false;
        const tryBytecode = allowCache && (remote || needsTransform || needsCompile);

        if (tryBytecode) {
            const cached = this.jsc.load(
                info.localPath,
                remote && fileBacked,
                fileBacked ? resolveMtime?.(info.localPath) : undefined,
                moduleId,
            );
            if (cached) {
                Object.assign(cached.meta, meta);
                this.esmCache.set(cacheKey, cached);
                return cached;
            }
        }

        // VFS (pack) or fs → transform → compile
        this.esmLoading.add(cacheKey);
        const bytes = readBytes(info.localPath);
        const code = this.transformer.transformBytes(bytes, info.localPath, metaLang(meta), moduleId);
        let mod: CModuleEngine.Module;
        try {
            mod = this.compileEsm(code, moduleId, info.localPath);
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
            log.debug('loader', () => `populated ESM placeholder: ${info.specPath} (${Object.keys(ns).length} exports)`);
            return cached;
        }

        if (tryBytecode && fileBacked) {
            if (remote) this.jsc.persist(info.localPath, mod, moduleId);
            else        this.jsc.persistLocal(info.localPath, mod, moduleId);
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

    private loadBytes(info: ModuleInfo): CModuleEngine.Module {
        const mod = engine.Module.create(moduleRef(info));
        // Copy: callers may mutate the default export buffer.
        mod.export('default', readBytes(info.localPath).slice());
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
