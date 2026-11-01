import { moduleEvaluationKey, moduleRef, type RuntimeConfig, type ModuleInfo } from '../types';
import { bunPayloadViewRef, canonicalBunSpecifier } from '../resolve/bun-specifier';
import { Transformer } from '../source/transform';
import { JscCache, isRemote, isFileBackedPath, type SourceFreshness } from '../source/cache';
import { readText, readBytes, log } from '../utils';
import { err, ErrorKind, requireCycleError } from '../errors';
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

/** True once a loader has blamed a concrete file (cjs.ts sets .kind, .cause.path). */
function isAttributedSyntaxError(e: SyntaxError): boolean {
    if (e.kind !== undefined) return true;
    const cause = Reflect.get(e, 'cause');
    return !!cause && typeof cause === 'object' && typeof Reflect.get(cause, 'path') === 'string';
}

export class EsmCompiler {
    private readonly esmCache    = new Map<string, CModuleEngine.Module>();
    // The Bun object behind each synthetic `bun` module, for require('bun').
    private readonly bunObjects  = new Map<string, object>();
    private readonly esmLoading  = new Set<string>();
    // Compile and evaluation guards share moduleEvaluationKey: local file aliases
    // cannot re-enter one another, while explicit moduleId views remain separate.
    private readonly esmInFlightPaths = new Set<string>();
    private readonly esmEvaluating = new Set<string>();
    readonly transformer: Transformer;
    readonly jsc: JscCache;

    constructor(private readonly cfg: RuntimeConfig) {
        this.jsc = new JscCache(cfg.cacheDir);
        this.transformer = new Transformer({
            sourceMaps: true,
            inlineSourceMaps: cfg.enableInlineSourceMap === true,
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
        if (info.specPath === 'bun' && info.moduleId === undefined && info.fileKind === 'source') {
            return this.loadBunView(info, resolveMtime);
        }
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
        // A nested load hook (e.g. a CJS dependency instantiated by
        // `new engine.Module`) throws through here already attributed to its own
        // file. Re-wrapping would blame the importer and print its source.
        if (isAttributedSyntaxError(e)) return e;
        const ne = err(ErrorKind.SyntaxError, `Syntax error in ${localPath}: ${e.message}`, e);
        // cause.code feeds the fail-<hash>.log code frame — decode bytes
        // here (error path only) so reportSyntax() always sees a string.
        const text = typeof code === 'string' ? code : engine.decodeString(code);
        ne.cause = { source: e, code: text, path: localPath };
        return ne;
    }

    private loadEsm(info: ModuleInfo, meta: Record<string, unknown>, resolveMtime?: (p: string) => number | undefined): CModuleEngine.Module {
        const cacheKey = moduleRef(info);
        const moduleId = cacheKey;
        const evalScope = moduleEvaluationKey(info);
        const hit = this.esmCache.get(cacheKey);
        if (hit) {
            if (meta.main !== undefined) Reflect.set(hit.meta, 'main', meta.main);
            return hit;
        }

        // Circular dependency guard
        if (this.esmLoading.has(cacheKey)) {
            log.debug('loader', () => `cycle: ${info.specPath} -- returning placeholder`);
            const placeholder = engine.Module.create(cacheKey);
            this.esmCache.set(cacheKey, placeholder);
            return placeholder;
        }

        const remote = isRemote(info.specPath);
        const fileBacked = isFileBackedPath(info.localPath);
        // Extension policy (works for pack:/name.ts keys, not only host paths).
        // Transform-source paths are always cache candidates; plain local .js only when file-backed (L2).
        const needsTransform = isTransformSourcePath(info.localPath);
        const needsCompile = !needsTransform && isCompiledSourcePath(info.localPath);
        const allowCache = info.cacheBytecode !== false && this.cfg.enableCache !== false;
        const tryBytecode = allowCache && (remote || needsTransform || needsCompile);

        if (tryBytecode) {
            // In-flight for the bytecode read too: jsc.load() links the module,
            // which runs a CJS dependency's body, and that body can require()
            // back into this very module. Without the window isInFlight() is
            // false there, so bridge.ts's require-esm guard misses and the cycle
            // surfaces later as the opposite direction ("Cannot import CommonJS
            // Module b.cjs" instead of "Cannot require() ES Module a.mjs").
            const alreadyLoading = this.esmInFlightPaths.has(evalScope);
            this.esmInFlightPaths.add(evalScope);
            let cached: CModuleEngine.Module | null;
            try {
                cached = this.jsc.load(
                    info.localPath,
                    remote && fileBacked,
                    fileBacked ? resolveMtime?.(info.localPath) : undefined,
                    moduleId,
                );
            } finally {
                if (!alreadyLoading) this.esmInFlightPaths.delete(evalScope);
            }
            if (cached) {
                Object.assign(cached.meta, meta);
                this.esmCache.set(cacheKey, cached);
                return cached;
            }
        }

        // VFS (pack) or fs → transform → compile
        this.esmLoading.add(cacheKey);
        const alreadyLoading = this.esmInFlightPaths.has(evalScope);
        this.esmInFlightPaths.add(evalScope);
        let sourceFreshness: SourceFreshness | undefined;
        let mod: CModuleEngine.Module;
        let inlineMapped = false;
        try {
            // The sidecar must describe the bytes about to be compiled, not whatever
            // revision happens to be on disk after compilation finishes.
            const source = fileBacked && tryBytecode
                ? this.jsc.takeSourceSnapshot(info.localPath, moduleId)
                : undefined;
            sourceFreshness = source?.freshness;
            const bytes = source?.bytes ?? readBytes(info.localPath);
            const code = this.transformer.transformBytes(bytes, info.localPath, metaLang(meta), moduleId);
            // Consume immediately: every transformBytes load must clear its
            // marker, whether or not this load reaches the persist gate.
            inlineMapped = this.transformer.tookInlineSourceMap(moduleId);
            mod = this.compileEsm(code, moduleId, info.localPath);
        } catch (e) {
            this.esmCache.delete(cacheKey);
            throw e;
        } finally {
            // Reads and transforms can fail before compileEsm's own error wrapper
            // runs. Never strand a failed module in either in-flight set: doing so
            // turns the next import into a permanent empty placeholder and keeps
            // Runtime.cleanup() from releasing the compiler.
            this.esmLoading.delete(cacheKey);
            if (!alreadyLoading) this.esmInFlightPaths.delete(evalScope);
        }

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

        // An embedded map is injected at compile time and lives in the runtime,
        // not in the bytecode: annotated modules must stay source-cached so a
        // later load re-injects instead of serving unmapped positions.
        if (tryBytecode && fileBacked && sourceFreshness && !inlineMapped) {
            if (remote) this.jsc.persist(info.localPath, mod, moduleId, sourceFreshness);
            else        this.jsc.persistLocal(info.localPath, mod, moduleId, sourceFreshness);
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
        const evalScope = moduleEvaluationKey(info);
        const alreadyLoading = this.esmInFlightPaths.has(evalScope);
        this.esmInFlightPaths.add(evalScope);
        let mod: CModuleEngine.Module;
        try {
            const transformed = this.transformer.transform(code, info.localPath, metaLang(meta), moduleRef(info));
            mod = this.compileEsm(transformed, moduleRef(info), info.localPath);
        } finally {
            if (!alreadyLoading) this.esmInFlightPaths.delete(evalScope);
        }
        Object.assign(mod.meta, meta);
        this.esmCache.set(cacheKey, mod);
        return mod;
    }
    /** The Bun object (ESM default) behind an already-loaded synthetic `bun` module. */
    bunObject(info: ModuleInfo): object {
        const bun = this.bunObjects.get(moduleRef(info));
        if (!bun) throw err(ErrorKind.Generic, `Bun module "${info.specPath}" is not loaded`);
        return bun;
    }

    /**
     * Native Bun exposes `import Bun, * as ns from 'bun'` with `Bun === globalThis.Bun`
     * and a namespace whose keys are exactly Object.keys(Bun): there is no `default`
     * key. QuickJS cannot express that with a source module (a default export is
     * always a namespace key), but a C module's namespace is a plain object that
     * is not consulted when linking `import D from`. So the payload is loaded as a
     * hidden module, evaluated, and its default object is re-exported through a
     * C module whose `default` namespace property is deleted. The export entry
     * (what default imports bind to) is left in place.
     */
    private loadBunView(info: ModuleInfo, resolveMtime?: (p: string) => number | undefined): CModuleEngine.Module {
        const cacheKey = moduleRef(info);
        const hit = this.esmCache.get(cacheKey);
        if (hit) return hit;

        const payloadInfo: ModuleInfo = { ...info, moduleId: bunPayloadViewRef(canonicalBunSpecifier(info.specPath)!) };
        const evalScope = moduleEvaluationKey(payloadInfo);
        // The payload reaching `bun` again (e.g. through the Bun global getter) while
        // it evaluates would re-enter an EVALUATING QuickJS module, which aborts.
        if (this.isInFlight(evalScope)) {
            throw requireCycleError(cacheKey, info.localPath, 'require-esm');
        }
        const payload = this.loadEsm(payloadInfo, {}, resolveMtime);
        const result = engine.promiseResult(this.trackEvaluation(evalScope, () => payload.eval()));
        if (result === null) {
            throw err(ErrorKind.Generic,
                `Bun payload "${info.localPath}" must not use top-level await`,
                undefined, 'ERR_REQUIRE_ASYNC_MODULE');
        }
        const bun: unknown = payload.namespace.default;
        if (bun === null || (typeof bun !== 'object' && typeof bun !== 'function')) {
            throw err(ErrorKind.Generic, `Bun payload "${info.localPath}" has no default export object`);
        }

        const mod = engine.Module.create(cacheKey);
        mod.export('default', bun);
        for (const key of Object.keys(bun)) {
            if (key !== 'default') mod.export(key, Reflect.get(bun, key));
        }
        const ns = mod.namespace;
        if (!Reflect.deleteProperty(ns, 'default')) {
            throw err(ErrorKind.Generic, 'Cannot hide the default key of the Bun module namespace');
        }
        Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' });
        Object.freeze(ns);

        this.bunObjects.set(cacheKey, bun);
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
        this.bunObjects.clear();
    }

    /** True while this moduleEvaluationKey is compiling or evaluating. */
    isInFlight(evalScope: string): boolean {
        return this.esmInFlightPaths.has(evalScope) || this.esmEvaluating.has(evalScope);
    }

    /** Run `fn` with its moduleEvaluationKey marked as evaluating, so a CJS module reached
     *  during evaluation cannot require() back into it. */
    trackEvaluation<T>(evalScope: string, fn: () => T): T {
        const alreadyEvaluating = this.esmEvaluating.has(evalScope);
        this.esmEvaluating.add(evalScope);
        try { return fn(); }
        finally { if (!alreadyEvaluating) this.esmEvaluating.delete(evalScope); }
    }

    hasPendingLoads(): boolean {
        return this.esmLoading.size > 0;
    }

    private cacheKey(info: ModuleInfo): string {
        return moduleRef(info);
    }
}
