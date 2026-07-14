import type { ModuleInfo } from '../types';
import { dirname, joinPaths, isAbsolute, extname, isRelative, resolveFile, safeParse, log, isWindows, hasLeadingSlashDrive, normalizePath, readText } from '../utils';
import { err, ErrorKind } from '../errors';
import { isBuiltinSpecifier } from '../resolve/builtins';
import { guessFileKind } from '../resolve/protocols/base';
import { createCtx, detectFormat, packagePathNotExportedError, resolveExports } from '../resolve/pkg';
import { URL } from '../utils/url';
import { buildCjsWrapperSource, cjsContextSlot, type CjsContext } from './cjs-wrap';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const napi = import.meta.use('nodeapi');
const NativeFunction = globalThis.Function;

export interface CjsModule {
    id: string; filename: string; loaded: boolean; exports: unknown;
    require: CjsRequireFn; children: CjsModule[]; parent: CjsModule | null; paths: string[];
}

export interface CjsRequireFn {
    (id: string): unknown;
    resolve: (id: string, opts?: { paths?: string[] }) => string;
    cache: Record<string, CjsModule>; main: CjsModule | null;
    extensions: Record<string, (m: CjsModule, f: string) => void>;
}

export interface CjsDeps {
    /** Resolve a node builtin to its concrete module info. */
    resolveBuiltin(name: string, parent: string): ModuleInfo;
    /** Sync ESM load for require(); returns namespace via promiseResult. */
    loadEsmSync(info: ModuleInfo): Record<string, unknown>;
    /** Load a wasm module synchronously for CJS require(.wasm). */
    loadWasmSync?(info: ModuleInfo): Record<string, unknown>;
    /** Resolve any external specifier → concrete module info. */
    resolveExternal(req: string, parent: string): ModuleInfo | null;
    /** Prepare source for CJS execution (e.g. strip TS/JSX syntax). */
    prepareSource?(code: string, filePath: string): string | null;
    /** Fresh EVAL_COMPILE_ONLY bytecode for path, or null. */
    loadCjsCompiled?(localPath: string): unknown | null;
    /** Persist freshly compiled CJS bytecode (already engine.serialize()'d). */
    persistCjsCompiled?(localPath: string, bytes: ArrayBuffer): void;
    /** Synthetic runtime parent for materialized container files, if any. */
    runtimeParent?(localPath: string): string | null;
}

interface ResolvedCjsRequest {
    info: ModuleInfo;
    isCjs: boolean;
}

// Performance: counter-based CJS context keys (no regex), dir-level path cache

const INTERNAL_ID = Symbol('cts.cjs.id');
const INTERNAL_FILENAME = Symbol('cts.cjs.filename');

type InternalCjsModule = CjsModule & {
    [INTERNAL_ID]: string;
    [INTERNAL_FILENAME]: string;
    path?: string;
};

type ExecError = Error & {
    kind?: ErrorKind;
    cause?: unknown;
};

type Callable = (...args: unknown[]) => unknown;

function splitBarePackageId(id: string): { name: string; subpath: string } | null {
    if (!id || id.startsWith('.') || id.startsWith('/') || id.includes(':')) return null;
    if (id.startsWith('@')) {
        const firstSlash = id.indexOf('/');
        if (firstSlash <= 1) return null;
        const secondSlash = id.indexOf('/', firstSlash + 1);
        const name = secondSlash === -1 ? id : id.slice(0, secondSlash);
        return {
            name,
            subpath: secondSlash === -1 ? '.' : `./${id.slice(secondSlash + 1)}`,
        };
    }
    const slash = id.indexOf('/');
    const name = slash === -1 ? id : id.slice(0, slash);
    if (!name) return null;
    return {
        name,
        subpath: slash === -1 ? '.' : `./${id.slice(slash + 1)}`,
    };
}

/** True for a scheme-qualified id like "pack:///0.js" — mirrors resolve/index.ts's protoOf(). */
function hasProtocolScheme(s: string): boolean {
    const ci = s.indexOf(':');
    if (ci < 2 || ci > 8) return false;
    for (let i = 0; i < ci; i++) {
        const c = s.charCodeAt(i);
        if (c < 97 || c > 122) return false;
    }
    return true;
}

function toHostPath(path: string): string {
    return isWindows ? toWindowsHostPath(path) : path;
}

function toWindowsHostPath(path: string): string {
    const first = path.indexOf('/');
    if (first === -1) return path;

    let out = '';
    let start = 0;
    for (let i = first; i < path.length; i++) {
        if (path.charCodeAt(i) !== 47) continue;
        out += path.slice(start, i) + '\\';
        start = i + 1;
    }
    return out + path.slice(start);
}

function toHostPaths(paths: string[]): string[] {
    const out = new Array<string>(paths.length);
    for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        out[i] = path === undefined ? '' : toHostPath(path);
    }
    return out;
}

function getInternalFilename(mod: CjsModule): string {
    return (mod as InternalCjsModule)[INTERNAL_FILENAME] ?? mod.filename;
}
const _dirPaths = new Map<string, string[]>(); // dir → node_modules search list

export function buildPaths(dir: string): string[] {
    const hit = _dirPaths.get(dir);
    if (hit) return hit;
    // Synthetic pack:/ctsview: parents have no host node_modules walk.
    if (dir.startsWith('pack:') || dir.startsWith('ctsview:')) {
        const empty: string[] = [];
        _dirPaths.set(dir, empty);
        return empty;
    }
    const out: string[] = [];
    let d = dir;
    while (d !== '/') {
        out.push(joinPaths(d, 'node_modules'));
        const up = dirname(d);
        if (up === d) break;
        d = up;
    }
    _dirPaths.set(dir, out);
    return out;
}

/** Clear the directory paths cache */
export function clearDirPathsCache(): void {
    _dirPaths.clear();
}

function fileUrlToPath(url: string): string {
    const u = new URL(url);
    if (u.protocol !== 'file:') return url;
    let path = decodeURIComponent(u.pathname);
    if (hasLeadingSlashDrive(path)) path = path.slice(1);
    return path;
}

function normalizeRequireResolvePath(path: string): string {
    const local = path.startsWith('file:') ? fileUrlToPath(path) : path;
    return joinPaths(local, '<require.resolve>');
}

function normalizeRequireResolvePaths(paths: string[]): string[] {
    const out = new Array<string>(paths.length);
    for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        out[i] = normalizeRequireResolvePath(path ?? '');
    }
    return out;
}

function normalizeCJSExport(obj: unknown): unknown {
    if (obj !== null && typeof obj === 'object' && !Object.getPrototypeOf(obj)) {
        return { ...obj };
    }
    return obj;
}

function normalizeExecError(error: unknown, filename: string): Error {
    const e: ExecError = error instanceof Error ? error : new Error(String(error));
    if (e.kind === undefined) {
        e.kind = e instanceof SyntaxError ? ErrorKind.SyntaxError : ErrorKind.Generic;
    }
    if (e instanceof SyntaxError && !e.cause) {
        e.cause = { source: e, path: filename };
    }
    return e;
}

function createUninitializedRequire(): CjsRequireFn {
    const cache: Record<string, CjsModule> = Object.create(null);
    const extensions: Record<string, (m: CjsModule, f: string) => void> = Object.create(null);
    const requireFn = Object.assign(
        (_id: string): never => {
            throw new Error('CommonJS require() used before initialization');
        },
        {
            resolve(_id: string): string {
                throw new Error('CommonJS require.resolve() used before initialization');
            },
            cache,
            main: null as CjsModule | null,
            extensions,
        },
    );
    return requireFn;
}

function hasDynamicImportFunctionSource(src: string): boolean {
    return src.includes('Function') && findDynamicImportCall(src) !== null;
}

function isRegexWordChar(code: number): boolean {
    return code === 95 ||
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122);
}

function isDynamicImportWhitespace(code: number): boolean {
    return code === 32 || code === 160 || code === 65279 ||
        (code >= 9 && code <= 13);
}

function findDynamicImportCall(src: string, from = 0): { start: number; end: number } | null {
    for (let i = from; i < src.length; i++) {
        if (src.charCodeAt(i) !== 105) continue;
        if (i > 0 && isRegexWordChar(src.charCodeAt(i - 1))) continue;
        if (
            src.charCodeAt(i + 1) !== 109 ||
            src.charCodeAt(i + 2) !== 112 ||
            src.charCodeAt(i + 3) !== 111 ||
            src.charCodeAt(i + 4) !== 114 ||
            src.charCodeAt(i + 5) !== 116
        ) continue;

        let end = i + 6;
        while (end < src.length && isDynamicImportWhitespace(src.charCodeAt(end))) end++;
        if (src.charCodeAt(end) === 40) return { start: i, end };
        i = end;
    }
    return null;
}

function rewriteDynamicImportCalls(src: string): string | null {
    let hit = findDynamicImportCall(src);
    if (!hit) return null;

    let out = '';
    let pos = 0;
    while (hit) {
        out += src.slice(pos, hit.start) + '__cnoDynamicImport';
        pos = hit.end;
        hit = findDynamicImportCall(src, pos + 1);
    }
    return out + src.slice(pos);
}

function stringifyFunctionParams(args: unknown[]): string[] {
    const params = new Array<string>(args.length);
    for (let i = 0; i < args.length; i++) params[i] = String(args[i]);
    return params;
}

export class CjsLoader {
    // filename → module (includes in-progress modules for circular dep detection)
    readonly cache        = new Map<string, CjsModule>();
    private readonly builtinCache = new Map<string, CjsModule>();
    private mainModule: CjsModule | null = null;
    // require.cache is a plain object; internal store stays a Map.
    private readonly cacheView: Record<string, CjsModule> = new Proxy(Object.create(null), {
        has: (_t, key) => typeof key === 'string' && this.cache.has(key),
        get: (_t, key) => typeof key === 'string' ? this.cache.get(key) : undefined,
        set: (_t, key, value) => { if (typeof key === 'string') this.cache.set(key, value); return true; },
        deleteProperty: (_t, key) => { if (typeof key === 'string') this.cache.delete(key); return true; },
        ownKeys: () => [...this.cache.keys()],
        getOwnPropertyDescriptor: (_t, key) => {
            if (typeof key !== 'string' || !this.cache.has(key)) return undefined;
            return { value: this.cache.get(key), writable: true, enumerable: true, configurable: true };
        },
    });

    constructor(private readonly deps: CjsDeps) {}

    loadAndGet(filename: string, parentPath?: string, isMain = false): CjsModule {
        filename = normalizePath(filename);
        if (parentPath) parentPath = normalizePath(parentPath);
        const cached = this.cache.get(filename);
        if (cached?.loaded) {
            if (isMain) this.setMain(cached);
            return cached;
        }

        const parent = parentPath ? (this.cache.get(parentPath) ?? null) : null;
        const mod    = cached ?? this.make(filename, parent);
        if (!cached) this.cache.set(filename, mod);
        if (isMain) this.setMain(mod);
        this.exec(mod);
        return mod;
    }

    /** Load CJS source code from a string (for -e / --eval). */
    loadSourceAndGet(code: string, filename: string, parentPath?: string): CjsModule {
        filename = normalizePath(filename);
        if (parentPath) parentPath = normalizePath(parentPath);
        const cached = this.cache.get(filename);
        if (cached?.loaded) return cached;

        const parent = parentPath ? (this.cache.get(parentPath) ?? null) : null;
        const mod    = cached ?? this.make(filename, parent);
        if (!cached) this.cache.set(filename, mod);

        this.execWithSource(mod, code);
        return mod;
    }

    /** Pre-register a module stub so circular deps find it in cache. */
    preRegister(filename: string, parentPath: string): void {
        filename = normalizePath(filename);
        parentPath = normalizePath(parentPath);
        if (this.cache.has(filename)) return;
        let parent = this.cache.get(parentPath);
        if (!parent) {
            parent = this.synth(parentPath);
            this.cache.set(parentPath, parent);
        }
        this.cache.set(filename, this.make(filename, parent));
    }

    private make(filename: string, parent: CjsModule | null): CjsModule {
        filename = normalizePath(filename);
        const dir  = dirname(filename);
        const visibleFilename = toHostPath(filename);
        const mod: InternalCjsModule = {
            id: visibleFilename, filename: visibleFilename, loaded: false,
            exports: {},
            require: createUninitializedRequire(),
            children: [], parent,
            paths: toHostPaths(buildPaths(dir)),
            [INTERNAL_ID]: filename,
            [INTERNAL_FILENAME]: filename,
            path: toHostPath(dir),
        };
        mod.require = this.mkRequire(filename, mod);
        if (parent) parent.children.push(mod);
        return mod;
    }

    private synth(filename: string): CjsModule {
        filename = normalizePath(filename);
        const dir = dirname(filename);
        return {
            id: toHostPath(filename), filename: toHostPath(filename), loaded: true,
            exports: {}, require: createUninitializedRequire(),
            children: [], parent: null, paths: toHostPaths(buildPaths(dir)),
            [INTERNAL_ID]: filename,
            [INTERNAL_FILENAME]: filename,
            path: toHostPath(dir),
        } as InternalCjsModule;
    }

    private setMain(mod: CjsModule): void {
        mod.id = '.';
        this.mainModule = mod;
        mod.require.main = mod;
    }

    private exec(mod: CjsModule): void {
        const ext = extname(getInternalFilename(mod));
        if (ext === '.json') {
            this.execJson(mod);
            return;
        }
        if (ext === '.node') {
            this.execNodeAddon(mod);
            return;
        }
        this.execJs(mod);
    }

    private execNodeAddon(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        try {
            if (!napi) {
                throw err(ErrorKind.Generic, 'Node-API native addons are unavailable in this runtime context');
            }
            mod.exports = napi.dlopen(filename);
            mod.loaded = true;
        } catch (e) {
            this.cache.delete(filename);
            throw err(ErrorKind.Generic, `Error loading native addon '${filename}': ${e}`, e);
        }
    }

    private execJson(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        try {
            mod.exports = safeParse(readText(filename));
            mod.loaded  = true;
        } catch (e) {
            this.cache.delete(filename);
            throw err(ErrorKind.SyntaxError, `JSON parse error in '${filename}': ${e}`, e);
        }
    }

    private execJs(mod: CjsModule): void {
        const filename = getInternalFilename(mod);

        // Non-null = valid bytecode. Do not retry on run failure: may be
        // user code, and retry would double side effects (same as ESM path).
        const cached = this.deps.loadCjsCompiled?.(filename);
        if (cached != null) {
            log.debug('cjs', () => `bytecode cache hit: ${filename}`);
            // No source on cache hit — patch Function for dynamic import defensively.
            this.runCompiled(mod, cached, true);
            return;
        }

        this.execJsFresh(mod, filename);
    }

    private execJsFresh(mod: CjsModule, filename: string): void {
        let src = readText(filename);
        // Transform TS/ESM source for CJS execution if a transformer is available
        if (this.deps.prepareSource) {
            const transformed = this.deps.prepareSource(src, filename);
            if (transformed !== null) src = transformed;
        }
        this.execWithSource(mod, src);
    }

    private execWithSource(mod: CjsModule, src: string): void {
        if (src.startsWith('#!')) src = src.slice(src.indexOf('\n'));

        const filename = getInternalFilename(mod);
        const shouldPatchFunction = hasDynamicImportFunctionSource(src);

        let compiled: unknown;
        try {
            compiled = engine.eval(buildCjsWrapperSource(src), filename,
                engine.EVAL_GLOBAL | engine.EVAL_COMPILE_ONLY | engine.EVAL_NEW_BACKTRACE);
        } catch (e) {
            this.cache.delete(filename);
            log.debug('cjs', () => `compile error: ${filename}`, e);
            throw normalizeExecError(e, filename);
        }

        if (this.deps.persistCjsCompiled) {
            try {
                this.deps.persistCjsCompiled(filename, engine.serialize(compiled).buffer);
            } catch (e) {
                log.debug('cjs', () => `persist compiled failed: ${filename}`, e);
            }
        }

        this.runCompiled(mod, compiled, shouldPatchFunction);
    }

    /** Run EVAL_COMPILE_ONLY value with CJS locals in the global ctx slot. */
    private runCompiled(mod: CjsModule, compiled: unknown, needsFunctionPatch: boolean): void {
        const filename = getInternalFilename(mod);
        const ctx: CjsContext = {
            exports:    mod.exports,
            require:    mod.require,
            module:     mod,
            __filename: mod.filename,
            __dirname:  toHostPath(dirname(filename)),
        };
        Reflect.set(globalThis, cjsContextSlot(), ctx);

        const previousFunction = globalThis.Function;
        if (needsFunctionPatch) {
            Reflect.set(globalThis, 'Function', this.contextualFunction(filename));
        }

        try {
            engine.evalCompiled(compiled);
            mod.loaded = true;
        } catch (e) {
            this.cache.delete(filename);
            log.debug('cjs', () => `eval error: ${filename}`, e);
            throw normalizeExecError(e, filename);
        } finally {
            if (needsFunctionPatch) {
                Reflect.set(globalThis, 'Function', previousFunction);
            }
            Reflect.deleteProperty(globalThis, cjsContextSlot());
        }
    }

    private contextualFunction(filename: string): Callable {
        const self = this;
        const nativeDynamicImport = NativeFunction('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
        const resolveDynamicImport = (specifier: unknown): string => {
            const raw = String(specifier);
            const resolved = self.resolveId(raw, filename);
            return resolved?.info.specPath ?? raw;
        };

        const contextual: Callable = function(...args: unknown[]): unknown {
            const body = String(args.pop() ?? '');
            const params = stringifyFunctionParams(args);
            const rewritten = rewriteDynamicImportCalls(body);
            if (rewritten === null) {
                return NativeFunction(...params, body) as Callable;
            }

            const compiled = NativeFunction(...params, '__cnoDynamicImport', rewritten) as Callable;
            const dynamicImport = (specifier: unknown) => nativeDynamicImport(resolveDynamicImport(specifier));
            return function(this: unknown, ...callArgs: unknown[]) {
                return Reflect.apply(compiled, this, [...callArgs, dynamicImport]);
            };
        };
        Object.setPrototypeOf(contextual, NativeFunction);
        Object.defineProperty(contextual, 'prototype', {
            value: NativeFunction.prototype,
            writable: false,
            enumerable: false,
            configurable: false,
        });
        return contextual;
    }

    // require() factory

    public mkRequire(parentPath: string, parentMod: CjsModule | null = null): CjsRequireFn {
        const self = this;

        function require(id: string): unknown {
            return self.requireFrom(id, parentPath, parentMod);
        }

        require.resolve = function(id: string, opts?: { paths?: string[] }): string {
            const searchIn = opts?.paths ? normalizeRequireResolvePaths(opts.paths) : [parentPath];
            for (const p of searchIn) {
                const r = self.resolveId(id, p);
                if (r) return toHostPath(r.info.localPath);
            }
            throw err(ErrorKind.ModuleNotFound, `Cannot resolve module '${id}'`);
        };
        require.cache      = self.cacheView;
        require.main       = self.mainModule;
        require.extensions = {
            '.js':   (m: CjsModule) => self.execJs(m),
            '.json': (m: CjsModule) => self.execJson(m),
            '.node': (m: CjsModule) => self.execNodeAddon(m),
        };
        return require as CjsRequireFn;
    }

    public preloadModule(id: string, parentPath: string): unknown {
        return this.requireFrom(id, parentPath, null, true);
    }

    private requireFrom(id: string, parentPath: string, parentMod: CjsModule | null, forceJsCjs = false): unknown {
        // 1. Node built-ins
        const bare = id.startsWith('node:') ? id.slice(5) : id;
        if (isBuiltinSpecifier(id)) return this.loadBuiltin(bare, parentPath).exports;

        // 2. Resolve
        const resolved = this.resolveId(id, parentPath);
        if (!resolved) throw err(ErrorKind.ModuleNotFound, `Cannot find module '${id}' from '${parentPath}'`);

        const { info, isCjs } = resolved;
        const path = info.localPath;
        const forceCjs = forceJsCjs && info.fileKind === 'source' && extname(path) === '.js';
        log.debug('cjs', () => `require('${id}') → ${path} isCjs=${isCjs || forceCjs}`);

        // 3. CJS → ESM interop: if resolved is ESM, load it via ESM pipeline
        if (!isCjs && !forceCjs) {
            return this.requireEsm(info, parentPath);
        }

        // 4. Cache hit (includes in-progress = circular dep → return partial exports)
        const hit = this.cache.get(path);
        if (hit) return hit.exports; // may be partial for circular deps

        // 5. Load CJS
        return this.loadResolvedCjs(path, parentMod).exports;
    }

    /** require(esm): loadEsmSync + same cache as CJS (Node 22+ semantics). */
    private requireEsm(info: ModuleInfo, parentPath: string): unknown {
        const path = info.localPath;
        const hit = this.cache.get(path);
        if (hit) return hit.exports;

        // Native addons (.node) must go through CJS exec path, not ESM compile
        if (extname(path) === '.node') {
            const mod = this.loadAndGet(path, parentPath);
            return mod.exports;
        }

        const result = info.fileKind === 'wasm' && this.deps.loadWasmSync
            ? this.deps.loadWasmSync(info)
            : this.deps.loadEsmSync(info);
        const mod = this.synth(path);
        mod.exports = normalizeCJSExport(
            'module.exports' in result
                ? result['module.exports']
                : 'default' in result
                    ? result['default']
                    : result
        );
        this.cache.set(path, mod);
        return mod.exports;
    }

    /** Builtin via deps; ns.default same as requireEsm. */
    private loadBuiltin(name: string, parent: string): CjsModule {
        const hit = this.builtinCache.get(name);
        if (hit) return hit;

        const info = this.deps.resolveBuiltin(name, parent);
        const ns = this.deps.loadEsmSync(info);

        const mod = this.synth(info.localPath);
        const copyMissingExports = (target: object) => {
            for (const k of Object.keys(ns)) {
                if (k === 'default' || k in target) continue;
                const desc = Object.getOwnPropertyDescriptor(ns, k);
                if (!desc) continue;
                try {
                    Object.defineProperty(target, k, desc);
                } catch {}
            }
        };
        // Builtins should preserve the prototype of their default export when one exists,
        // otherwise CommonJS consumers observe a null-prototype object unlike Node.js.
        const defaultExport = ns.default;
        if ('default' in ns && defaultExport) {
            if (typeof defaultExport === 'function') {
                const target = defaultExport;
                copyMissingExports(target);
                mod.exports = target;
            } else if (typeof defaultExport === 'object') {
                const target = Object.isExtensible(defaultExport)
                    ? defaultExport
                    : Object.assign({}, defaultExport);
                copyMissingExports(target);
                mod.exports = target;
            } else {
                mod.exports = defaultExport;
            }
        } else {
            mod.exports = Object.assign({}, ns);
        }
        this.builtinCache.set(name, mod);
        return mod;
    }

    private loadResolvedCjs(path: string, parent: CjsModule | null): CjsModule {
        const mod = this.make(path, parent);
        this.cache.set(path, mod);
        try {
            this.exec(mod);
            return mod;
        } catch (e) {
            this.cache.delete(path);
            throw e;
        }
    }

    private resolveId(id: string, parentPath: string): ResolvedCjsRequest | null {
        // pack:/ctsview: parents have no FS base — full resolver; plain paths stay local-first.
        const runtimeParent = hasProtocolScheme(parentPath)
            ? parentPath
            : this.deps.runtimeParent?.(parentPath) ?? null;
        if (runtimeParent) {
            // resolveExternal rethrows non-miss; do not wrap in empty catch.
            const ext = this.deps.resolveExternal(id, runtimeParent);
            if (ext) return { info: ext, isCjs: ext.format === 'cjs' || ext.fileKind === 'json' };
            return null;
        }

        // CJS relative/absolute require() is anchored to the requiring file.
        // Try the local filesystem path before the generic resolver.
        if (isAbsolute(id)) return this.resolveLocalPath(id);
        if (isRelative(id)) return this.resolveLocalPath(joinPaths(dirname(parentPath), id));
        if (id === '.') return this.resolveLocalPath(dirname(parentPath));

        // External resolver first (covers npm, jsr, http, aliases, import map).
        // Non-miss errors (ProtocolDisabled, Network, …) propagate from resolveExternal.
        const ext = this.deps.resolveExternal(id, parentPath);
        if (ext) {
            return {
                info: ext,
                isCjs: ext.format === 'cjs' || ext.fileKind === 'json',
            };
        }

        // Local filesystem fallback for contexts that bypass the resolver, such as
        // internal createRequire() consumers operating directly on filenames.
        for (const dir of buildPaths(dirname(parentPath))) {
            const pkgResolved = this.resolveLocalPackage(id, dir);
            if (pkgResolved) return pkgResolved;
            const resolved = this.resolveLocalPath(joinPaths(dir, id));
            if (resolved) return resolved;
        }
        return null;
    }

    private resolveLocalPackage(id: string, nodeModulesDir: string): ResolvedCjsRequest | null {
        const parsed = splitBarePackageId(id);
        if (!parsed) return null;

        const pkgDir = joinPaths(nodeModulesDir, parsed.name);
        const ctx = createCtx(pkgDir, { forceCjs: true });
        if (!ctx) return null;

        if (ctx.pkg.exports) {
            const resolved = resolveExports(ctx, parsed.subpath);
            if (!resolved) throw packagePathNotExportedError(id);
            return this.infoFromLocalPath(resolved.path, resolved.format);
        }

        return this.resolveLocalPath(joinPaths(nodeModulesDir, id));
    }

    private resolveLocalPath(candidate: string): ResolvedCjsRequest | null {
        try {
            const path = normalizePath(resolveFile(normalizePath(candidate)));
            // .node always CJS; .js uses package type / extension (no source scan).
            const format = extname(path) === '.node' ? 'cjs' : detectFormat(path);
            const fileKind = guessFileKind(path);
            return this.infoFromLocalPath(path, format, fileKind);
        } catch {
            return null;
        }
    }

    private infoFromLocalPath(path: string, format = detectFormat(path), fileKind = guessFileKind(path)): ResolvedCjsRequest {
        const info: ModuleInfo = {
            specPath: path,
            localPath: path,
            format,
            fileKind,
        };
        return { info, isCjs: format === 'cjs' || fileKind === 'json' };
    }
}
