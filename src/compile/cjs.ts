import type { ModuleInfo } from '../types';
import { dirname, fileUrlToPath, joinPaths, isAbsolute, extname, isRelative, resolveFile, safeParse, log, isWindows, normalizePath, readText, toHostPath as sharedToHostPath, toHostPaths as sharedToHostPaths, hasSchemeId, schemeId } from '../utils';
import { err, ErrorKind, requireCycleError } from '../errors';
import { isBuiltinSpecifier } from '../resolve/builtins';
import { guessFileKind } from '../resolve/protocols/base';
import { createCtx, detectFormat, packagePathNotExportedError, resolveExports } from '../resolve/pkg';
import { buildCjsWrapperSource, cjsContextSlot, type CjsContext } from './cjs-wrap';
import { getNodeModuleInterop } from './node-interop';
import type { SourceFreshness, SourceSnapshot } from '../source/cache';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const napi = import.meta.use('nodeapi');
const NativeFunction = globalThis.Function;

export interface CjsModule {
    id: string; filename: string; loaded: boolean; exports: unknown;
    require: CjsRequireFn; children: CjsModule[]; parent: CjsModule | null; paths: string[];
    /** CommonJS extension handlers (pirates/ts-node) call this entry point. */
    _compile?: (code: string, filename: string) => unknown;
}

export interface CjsRequireFn {
    (id: string): unknown;
    resolve: {
        (id: string, opts?: { paths?: string[] }): string;
        /** Node's require.resolve.paths — null for builtins. */
        paths(id: string): string[] | null;
    };
    cache: Record<string, CjsModule>; main: CjsModule | null;
    extensions: Record<string, (m: CjsModule, f: string) => void>;
}

export interface CjsDeps {
    /** Resolve a node builtin to its concrete module info. */
    resolveBuiltin(name: string, parent: string): ModuleInfo;
    /** Sync ESM load for require(); returns namespace via promiseResult.
     *  `from` is the requiring file, used for cycle error attribution. */
    loadEsmSync(info: ModuleInfo, from?: string): Record<string, unknown>;
    /** Load a wasm module synchronously for CJS require(.wasm). */
    loadWasmSync?(info: ModuleInfo): Record<string, unknown>;
    /** Resolve any external specifier → concrete module info. */
    resolveExternal(req: string, parent: string): ModuleInfo | null;
    /** Inspection-only resolve for require.resolve(): local/store/lock, never
     *  fetches or installs. Optional — a deps object without it falls back to
     *  resolveExternal, which keeps hand-built test doubles working. */
    resolveExternalCached?(req: string, parent: string): ModuleInfo | null;
    /** Prepare source for CJS execution (e.g. strip TS/JSX syntax). */
    prepareSource?(code: string, filePath: string): string | null;
    /** Fresh EVAL_COMPILE_ONLY bytecode for path, or null. */
    loadCjsCompiled?(localPath: string): unknown | null;
    /** Source snapshot retained by a preceding bytecode-cache miss. */
    takeSourceSnapshot?(localPath: string): SourceSnapshot | undefined;
    /** Persist freshly compiled CJS bytecode (already engine.serialize()'d). */
    persistCjsCompiled?(localPath: string, bytes: ArrayBuffer, source?: SourceFreshness): void;
    captureSourceFreshness?(localPath: string): SourceFreshness | undefined;
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
/** Marks a cache entry that only exists to be some child's `module.parent`.
 *  preRegister() synthesizes one for an ESM importer, and synth() stamps it
 *  `loaded: true` — so without this flag it is indistinguishable from a fully
 *  loaded module and its empty `exports` satisfies a require() of that path. */
const PARENT_STUB = Symbol('cts.cjs.parentStub');

type InternalCjsModule = CjsModule & {
    [INTERNAL_ID]: string;
    [INTERNAL_FILENAME]: string;
    [PARENT_STUB]?: boolean;
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

/** True for a scheme-qualified module identity, excluding Windows drives. */
function hasProtocolScheme(s: string): boolean {
    return hasSchemeId(s);
}

function toHostPath(path: string): string {
    return sharedToHostPath(path);
}

function toHostPaths(paths: string[]): string[] {
    return sharedToHostPaths(paths);
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

function normalizeRequireResolvePath(path: string): string {
    const local = schemeId(path) === 'file' ? fileUrlToPath(path) : path;
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

/** Build Node's MODULE_NOT_FOUND error with a non-enumerable requireStack. */
function moduleNotFoundError(id: string, parentPath: string): Error {
    const stack = parentPath ? [toHostPath(parentPath)] : [];
    const suffix = stack.length ? `\nRequire stack:\n- ${stack.join('\n- ')}` : '';
    const e = err(ErrorKind.ModuleNotFound, `Cannot find module '${id}'${suffix}`);
    Object.defineProperty(e, 'requireStack', {
        value: stack, writable: true, enumerable: false, configurable: true,
    });
    return e;
}

function normalizeCJSExport(obj: unknown): unknown {
    if (obj !== null && typeof obj === 'object' && !Object.getPrototypeOf(obj)) {
        return { ...obj };
    }
    return obj;
}

/** require(esm) view for a namespace carrying `default`: adds __esModule like Node.
 *  Getters keep bindings live; QuickJS namespaces are non-extensible so we cannot tag them. */
function esmRequireView(ns: Record<string, unknown>): Record<string, unknown> {
    const view: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(ns)) {
        if (k === '__esModule') continue;
        Object.defineProperty(view, k, {
            get: () => ns[k],
            enumerable: true,
            configurable: false,
        });
    }
    Object.defineProperty(view, '__esModule', {
        value: true, writable: true, enumerable: true, configurable: false,
    });
    Object.defineProperty(view, Symbol.toStringTag, { value: 'Module' });
    return Object.preventExtensions(view);
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
    const uninitialized = (): never => {
        throw new Error('CommonJS require.resolve() used before initialization');
    };
    const resolve = ((_id: string): string => uninitialized()) as CjsRequireFn['resolve'];
    resolve.paths = (_id: string): string[] | null => uninitialized();
    const requireFn = Object.assign(
        (_id: string): never => {
            throw new Error('CommonJS require() used before initialization');
        },
        {
            resolve,
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

/** Map-like cache surface shared with the Node module bridge. */
export interface CjsCacheStore {
    readonly size: number;
    get(key: string): CjsModule | undefined;
    has(key: string): boolean;
    set(key: string, value: CjsModule): CjsCacheStore;
    delete(key: string): boolean;
    clear(): void;
    keys(): IterableIterator<string>;
}

/**
 * The CJS cache has one backing store.  The normal store is keyed by CTS'
 * POSIX paths; a Node replacement is used directly and receives host paths at
 * the boundary so `delete require.cache[require.resolve(x)]` remains live.
 */
export class CjsCacheAdapter implements CjsCacheStore {
    private readonly store = new Map<string, CjsModule>();
    private external: Record<string, CjsModule> | undefined;
    private readonly defaultTarget = Object.create(null) as Record<string, CjsModule>;
    private defaultViewDetached = false;
    private readonly defaultView: Record<string, CjsModule>;

    constructor() {
        const self = this;
        this.defaultView = new Proxy(this.defaultTarget, {
            has: (target, key) => {
                if (typeof key !== 'string') return Reflect.has(target, key);
                return self.defaultViewDetached
                    ? Reflect.has(target, key)
                    : self.store.has(self.normalized(key));
            },
            get: (target, key, receiver) => {
                if (typeof key !== 'string') return Reflect.get(target, key, receiver);
                return self.defaultViewDetached
                    ? Reflect.get(target, key, receiver)
                    : self.store.get(self.normalized(key));
            },
            set: (target, key, value) => {
                if (typeof key !== 'string') return Reflect.set(target, key, value);
                if (self.defaultViewDetached) return Reflect.set(target, key, value);
                self.store.set(self.normalized(key), value as CjsModule);
                return true;
            },
            deleteProperty: (target, key) => {
                if (typeof key !== 'string') return Reflect.deleteProperty(target, key);
                if (self.defaultViewDetached) return Reflect.deleteProperty(target, key);
                self.store.delete(self.normalized(key));
                return true;
            },
            ownKeys: (target) => {
                if (self.defaultViewDetached) return Reflect.ownKeys(target);
                const keys: string[] = [];
                for (const key of self.store.keys()) keys.push(toHostPath(key));
                return keys;
            },
            getOwnPropertyDescriptor: (target, key) => {
                if (typeof key !== 'string') return Reflect.getOwnPropertyDescriptor(target, key);
                if (self.defaultViewDetached) return Reflect.getOwnPropertyDescriptor(target, key);
                const value = self.store.get(self.normalized(key));
                if (value === undefined) return undefined;
                return { value, writable: true, enumerable: true, configurable: true };
            },
        });
    }

    /** Public object for standalone CTS consumers; Node may supply its own view. */
    view(): Record<string, CjsModule> {
        return this.external ?? this.defaultView;
    }

    /** Switch to a user-owned object without copying entries into a second map. */
    replace(value: Record<string, CjsModule>): void {
        if (value === this.defaultView) {
            this.external = undefined;
            this.restoreDefaultView();
            return;
        }
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
            throw new TypeError('require.cache must be an object');
        }
        if (!this.external) this.detachDefaultView();
        this.external = value;
    }

    /** Restore the default store, optionally with a detached default view's entries. */
    reset(value?: Record<string, CjsModule>): void {
        this.external = undefined;
        this.restoreDefaultView(value);
    }

    get size(): number {
        return this.external ? Object.keys(this.external).length : this.store.size;
    }

    private normalized(key: string): string {
        return normalizePath(key);
    }

    private hostKey(key: string): string {
        return toHostPath(this.normalized(key));
    }

    /** Keep a saved default cache object independent after replacement. */
    private detachDefaultView(): void {
        if (this.defaultViewDetached) return;
        for (const key of Reflect.ownKeys(this.defaultTarget)) {
            Reflect.deleteProperty(this.defaultTarget, key);
        }
        for (const [key, value] of this.store) {
            Reflect.set(this.defaultTarget, toHostPath(key), value);
        }
        this.defaultViewDetached = true;
    }

    private restoreDefaultView(value?: Record<string, CjsModule>): void {
        const source = value ?? (this.defaultViewDetached ? this.defaultTarget : undefined);
        if (source) {
            this.store.clear();
            for (const key of Object.keys(source)) {
                this.store.set(this.normalized(key), Reflect.get(source, key) as CjsModule);
            }
        }
        this.defaultViewDetached = false;
    }

    private externalValue(key: string): CjsModule | undefined {
        const host = this.hostKey(key);
        const value = Reflect.get(this.external!, host) as CjsModule | undefined;
        if (value !== undefined || host === this.normalized(key)) return value;
        return Reflect.get(this.external!, this.normalized(key)) as CjsModule | undefined;
    }

    get(key: string): CjsModule | undefined {
        const normalized = this.normalized(key);
        return this.external ? this.externalValue(normalized) : this.store.get(normalized);
    }

    has(key: string): boolean {
        const normalized = this.normalized(key);
        if (!this.external) return this.store.has(normalized);
        const host = this.hostKey(normalized);
        return Reflect.has(this.external, host)
            || (host !== normalized && Reflect.has(this.external, normalized));
    }

    set(key: string, value: CjsModule): CjsCacheStore {
        const normalized = this.normalized(key);
        if (!this.external) {
            this.store.set(normalized, value);
            return this;
        }
        const host = this.hostKey(normalized);
        if (!Reflect.set(this.external, host, value)) {
            throw new TypeError(`Cannot set require.cache['${host}']`);
        }
        return this;
    }

    delete(key: string): boolean {
        const normalized = this.normalized(key);
        if (!this.external) return this.store.delete(normalized);
        const host = this.hostKey(normalized);
        let removed = false;
        if (Reflect.has(this.external, host)) {
            if (!Reflect.deleteProperty(this.external, host)) {
                throw new TypeError(`Cannot delete require.cache['${host}']`);
            }
            removed = true;
        }
        if (host !== normalized && Reflect.has(this.external, normalized)) {
            if (!Reflect.deleteProperty(this.external, normalized)) {
                throw new TypeError(`Cannot delete require.cache['${normalized}']`);
            }
            removed = true;
        }
        return removed;
    }

    clear(): void {
        if (!this.external) {
            this.store.clear();
            return;
        }
        for (const key of Object.keys(this.external)) {
            if (!Reflect.deleteProperty(this.external, key)) {
                throw new TypeError(`Cannot clear require.cache['${key}']`);
            }
        }
    }

    keys(): IterableIterator<string> {
        if (!this.external) return this.store.keys();
        const keys = new Set<string>();
        for (const key of Object.keys(this.external)) keys.add(this.normalized(key));
        return keys.values();
    }
}

class CjsExtensionsAdapter {
    private replacement: Record<string, ((m: CjsModule, f: string) => unknown) | undefined> | undefined;

    constructor(private readonly fallback: Record<string, ((m: CjsModule, f: string) => unknown) | undefined>) {}

    current(): Record<string, ((m: CjsModule, f: string) => unknown) | undefined> {
        const node = getNodeModuleInterop()?.getExtensions?.();
        return (node as Record<string, ((m: CjsModule, f: string) => unknown) | undefined> | undefined)
            ?? this.replacement
            ?? this.fallback;
    }

    replace(value: Record<string, ((m: CjsModule, f: string) => unknown) | undefined>): void {
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
            throw new TypeError('require.extensions must be an object');
        }
        this.replacement = value;
    }

    reset(): void {
        this.replacement = undefined;
    }
}

export class CjsLoader {
    // filename → module (includes in-progress modules for circular dep detection)
    readonly cache        = new CjsCacheAdapter();
    // Cache stubs and executing modules both have loaded === false.
    private readonly executing = new Set<string>();
    // Tracks ESM importers for CJS cycle error attribution.
    private readonly esmImporters = new Map<string, string>();
    private readonly builtinCache = new Map<string, CjsModule>();
    private mainModule: CjsModule | null = null;
    /**
     * Fallback table used when the Node polyfill has not been loaded (for
     * embedded CTS and isolated compiler tests).  Once node:module registers
     * its table, `currentExtensions()` below switches every require to that
     * exact object by identity.
     */
    private readonly fallbackExtensions: Record<string, (m: CjsModule, f: string) => unknown> = Object.create(null);
    private readonly extensions: CjsExtensionsAdapter;

    constructor(private readonly deps: CjsDeps) {
        this.fallbackExtensions['.js'] = (m) => this.execJs(m);
        this.fallbackExtensions['.json'] = (m) => this.execJson(m);
        this.fallbackExtensions['.node'] = (m) => this.execNodeAddon(m);
        this.extensions = new CjsExtensionsAdapter(this.fallbackExtensions);
    }

    /**
     * Drop every module-owned reference held by this loader.
     *
     * CJS modules are retained in both the public require.cache map and the
     * private builtin/cycle tables.  A TypeScriptRuntime is terminal after
     * cleanup(), so retaining those objects serves no cache contract and can
     * keep complete export graphs alive for the lifetime of an embedding.
     */
    clearLoadedModules(): void {
        this.cache.clear();
        this.builtinCache.clear();
        this.executing.clear();
        this.esmImporters.clear();
        this.mainModule = null;
    }

    private currentCacheView(): Record<string, CjsModule> {
        const external = getNodeModuleInterop()?.getCache?.();
        return (external as Record<string, CjsModule> | undefined) ?? this.cache.view();
    }

    private currentExtensions(): Record<string, ((m: CjsModule, f: string) => unknown) | undefined> {
        return this.extensions.current();
    }

    replaceCache(value: Record<string, unknown>): void { this.cache.replace(value as Record<string, CjsModule>); }
    resetCache(value?: Record<string, unknown>): void {
        this.cache.reset(value as Record<string, CjsModule> | undefined);
    }
    replaceExtensions(value: Record<string, unknown>): void {
        this.extensions.replace(value as Record<string, (m: CjsModule, f: string) => unknown>);
    }
    resetExtensions(): void { this.extensions.reset(); }

    /** True while `filename`'s body is on the stack. An ESM module that imports
     *  such a file is closing a require()-crossed cycle: Node throws
     *  ERR_REQUIRE_CYCLE_MODULE rather than bridging the partial exports. */
    isExecuting(filename: string): boolean {
        return this.executing.has(normalizePath(filename));
    }

    /** Most recently entered still-executing CJS file, for cycle attribution.
     *  A Set preserves insertion order, so the last entry is the innermost
     *  frame — the module whose require() closed the loop. */
    innermostExecuting(): string | null {
        let last: string | null = null;
        for (const f of this.executing) last = f;
        return last;
    }

    /** The ERR_REQUIRE_CYCLE_MODULE an ESM importer must throw for `filename`,
     *  or null when importing it is legitimate.
     *
     *  Non-null exactly when the file's body is on the stack: the ESM module
     *  being compiled right now imports a CJS module that is mid-require of it,
     *  so bridging `mod.exports` would hand out the pre-require() half. Node
     *  refuses instead. Lives here rather than inline in ModuleCompiler.load so
     *  the decision is reachable without constructing a resolver.
     *
     *  A cached-but-never-executed stub (preRegister) is NOT a cycle — it also
     *  has loaded === false, which is why `executing` exists separately. */
    importCycleError(filename: string): Error | null {
        if (!this.isExecuting(filename)) return null;
        return requireCycleError(normalizePath(filename), this.importCycleFrom(filename), 'import-cjs');
    }

    /** Attribute import-CJS cycles to the ESM importer that closed the loop. */
    private importCycleFrom(filename: string): string {
        return this.esmImporters.get(normalizePath(filename))
            ?? this.innermostExecuting()
            ?? '<unknown>';
    }

    loadAndGet(filename: string, parentPath?: string, isMain = false): CjsModule {
        filename = normalizePath(filename);
        if (parentPath) parentPath = normalizePath(parentPath);
        const found = this.cache.get(filename);
        // Replace a pre-registered parent stub before executing its body.
        const cached = found && (found as InternalCjsModule)[PARENT_STUB] ? undefined : found;
        // Cycles observe partial exports without re-running the module body.
        if (cached && (cached.loaded || this.executing.has(filename))) {
            if (isMain) this.setMain(cached);
            return cached;
        }

        const parent = parentPath ? (this.cache.get(parentPath) ?? null) : null;
        const mod    = cached ?? this.make(filename, parent);
        if (!cached) this.cache.set(filename, mod);
        if (isMain) this.setMain(mod);
        this.execTracked(mod);
        return mod;
    }

    /** exec(), marking the module as on-stack so cycles do not re-enter it. */
    private execTracked(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        const parent = mod.parent;
        this.executing.add(filename);
        try { this.exec(mod); }
        catch (e) {
            this.removeFailedModule(mod, parent);
            throw e;
        }
        finally { this.executing.delete(filename); }
    }

    /** Load CJS source code from a string (for -e / --eval). */
    loadSourceAndGet(code: string, filename: string, parentPath?: string): CjsModule {
        filename = normalizePath(filename);
        if (parentPath) parentPath = normalizePath(parentPath);
        const cached = this.cache.get(filename);
        if (cached && (cached.loaded || this.executing.has(filename))) return cached;

        const parent = parentPath ? (this.cache.get(parentPath) ?? null) : null;
        const mod    = cached ?? this.make(filename, parent);
        if (!cached) this.cache.set(filename, mod);

        this.executing.add(filename);
        try { this.execWithSource(mod, code); }
        catch (e) {
            this.removeFailedModule(mod, parent);
            throw e;
        }
        finally { this.executing.delete(filename); }
        return mod;
    }

    /** Pre-register a module stub so circular deps find it in cache. */
    preRegister(filename: string, parentPath: string): void {
        filename = normalizePath(filename);
        parentPath = normalizePath(parentPath);
        // Record importers before the cache-hit path for cycle attribution.
        this.esmImporters.set(filename, parentPath);
        if (this.cache.has(filename)) return;
        let parent = this.cache.get(parentPath);
        if (!parent) {
            // Mark ESM-owned stubs so requireEsm still applies its cycle guard.
            parent = this.synth(parentPath);
            (parent as InternalCjsModule)[PARENT_STUB] = true;
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
        // Node-compatible extension handlers enter through module._compile.
        mod._compile = (code: string, file: string) => this.compileExtensionSource(mod, code, file);
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

    private removeFailedModule(mod: CjsModule, parent = mod.parent): void {
        const filename = getInternalFilename(mod);
        this.cache.delete(filename);
        if (!parent) return;
        const index = parent.children.indexOf(mod);
        if (index !== -1) parent.children.splice(index, 1);
    }

    private exec(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        const ext = extname(filename);
        const table = this.currentExtensions();
        // Node falls back to the `.js` handler for `.cjs` and other source
        // extensions; `.json`/`.node` remain exact-match extensions.
        const direct = table[ext];
        const handler = typeof direct === 'function'
            ? direct
            : ext !== '.json' && ext !== '.node' ? table['.js'] : undefined;
        const defaults = getNodeModuleInterop()?.defaultExtensions;

        // Default handlers retain CTS cache and virtual-source fast paths.
        if (handler === defaults?.['.js'] || handler === this.fallbackExtensions['.js']) {
            this.execJs(mod);
            return;
        }
        if (handler === defaults?.['.json'] || handler === this.fallbackExtensions['.json']) {
            this.execJson(mod);
            return;
        }
        // Default .node handlers stay direct to avoid cache recursion.
        if (ext === '.node' && (!handler || handler === defaults?.['.node'] || handler === this.fallbackExtensions['.node'])) {
            this.execNodeAddon(mod);
            return;
        }
        if (typeof handler === 'function') {
            handler(mod, toHostPath(filename));
            mod.loaded = true;
            return;
        }
        this.execJs(mod);
    }

    /** Source entry used by Node-compatible `.js` extension handlers. */
    private compileExtensionSource(mod: CjsModule, code: string, filename: string): void {
        const localPath = normalizePath(filename || getInternalFilename(mod));
        let src = code;
        if (this.deps.prepareSource) {
            const transformed = this.deps.prepareSource(src, localPath);
            if (transformed !== null) src = transformed;
        }
        // User-rewritten source must not enter the original bytecode cache.
        this.execWithSource(mod, src);
    }

    private execNodeAddon(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        try {
            if (!napi) {
                throw err(ErrorKind.Generic, 'Node-API native addons are unavailable in this runtime context',
                    undefined, 'ERR_DLOPEN_FAILED');
            }
            mod.exports = napi.dlopen(filename);
            mod.loaded = true;
        } catch (e) {
            this.removeFailedModule(mod);
            // Native addon failures require Node's ERR_DLOPEN_FAILED code.
            throw err(ErrorKind.Generic, `Error loading native addon '${filename}': ${e}`, e,
                'ERR_DLOPEN_FAILED');
        }
    }

    private execJson(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        try {
            mod.exports = safeParse(readText(filename));
            mod.loaded  = true;
        } catch (e) {
            this.removeFailedModule(mod);
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

        this.execJsFresh(mod, filename, this.deps.takeSourceSnapshot?.(filename));
    }

    private execJsFresh(mod: CjsModule, filename: string, snapshot?: SourceSnapshot): void {
        const sourceFreshness = snapshot?.freshness ?? this.deps.captureSourceFreshness?.(filename);
        let src = snapshot ? engine.decodeString(snapshot.bytes) : readText(filename);
        // Transform TS/ESM source for CJS execution if a transformer is available
        if (this.deps.prepareSource) {
            const transformed = this.deps.prepareSource(src, filename);
            if (transformed !== null) src = transformed;
        }
        this.execWithSource(mod, src, sourceFreshness);
    }

    private execWithSource(mod: CjsModule, src: string, sourceFreshness?: SourceFreshness): void {
        if (src.startsWith('#!')) {
            const nl = src.indexOf('\n');
            src = nl === -1 ? '' : src.slice(nl);
        }

        const filename = getInternalFilename(mod);
        const shouldPatchFunction = hasDynamicImportFunctionSource(src);

        let compiled: unknown;
        try {
            compiled = engine.eval(buildCjsWrapperSource(src), filename,
                engine.EVAL_GLOBAL | engine.EVAL_COMPILE_ONLY | engine.EVAL_NEW_BACKTRACE);
        } catch (e) {
            this.removeFailedModule(mod);
            log.debug('cjs', () => `compile error: ${filename}`, e);
            throw normalizeExecError(e, filename);
        }

        if (this.deps.persistCjsCompiled && sourceFreshness) {
            try {
                this.deps.persistCjsCompiled(filename, engine.serialize(compiled).buffer, sourceFreshness);
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
            this.removeFailedModule(mod);
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

        // require.resolve inspects cached resolution without fetching.
        const resolve = ((id: string, opts?: { paths?: string[] }): string => {
            // Builtins resolve to the original specifier, not a cache path.
            if (isBuiltinSpecifier(id)) return id;
            const searchIn = opts?.paths ? normalizeRequireResolvePaths(opts.paths) : [parentPath];
            for (const p of searchIn) {
                const r = self.resolveId(id, p, true);
                if (r) return toHostPath(r.info.localPath);
            }
            throw moduleNotFoundError(id, parentPath);
        }) as CjsRequireFn['resolve'];
        // Builtins have no filesystem search paths.
        resolve.paths = (id: string): string[] | null => {
            if (isBuiltinSpecifier(id)) return null;
            if (isRelative(id) || isAbsolute(id) || id === '.') return toHostPaths([dirname(parentPath)]);
            return toHostPaths(buildPaths(dirname(parentPath)));
        };
        require.resolve = resolve;
        Object.defineProperty(require, 'cache', {
            get: () => self.currentCacheView(),
            set: (value: Record<string, CjsModule>) => {
                const interop = getNodeModuleInterop();
                if (interop?.setCache) interop.setCache(value);
                else self.replaceCache(value);
            },
            enumerable: true,
            configurable: true,
        });
        require.main       = self.mainModule;
        Object.defineProperty(require, 'extensions', {
            get: () => self.currentExtensions(),
            set: (value: Record<string, (m: CjsModule, f: string) => unknown>) => {
                const interop = getNodeModuleInterop();
                if (interop?.setExtensions) interop.setExtensions(value);
                else self.replaceExtensions(value);
            },
            enumerable: true,
            configurable: true,
        });
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
        // A parent stub is not a load result: fall through so loadEsmSync can run
        // its in-flight check (throw on a cycle) or genuinely load the module.
        if (hit && !(hit as InternalCjsModule)[PARENT_STUB]) return hit.exports;

        // Native addons (.node) must go through CJS exec path, not ESM compile
        if (extname(path) === '.node') {
            const mod = this.loadAndGet(path, parentPath);
            return mod.exports;
        }

        const result = info.fileKind === 'wasm' && this.deps.loadWasmSync
            ? this.deps.loadWasmSync(info)
            : this.deps.loadEsmSync(info, parentPath);
        const mod = this.synth(path);
        // Node returns the whole namespace, not the bare default: an explicit
        // 'module.exports' export wins, otherwise keep every named export.
        if ('module.exports' in result) {
            mod.exports = normalizeCJSExport(result['module.exports']);
        } else if ('default' in result) {
            mod.exports = esmRequireView(result);
        } else {
            mod.exports = result;
        }
        this.cache.set(path, mod);
        return mod.exports;
    }

    /** Builtin via deps; default merged with named exports (not the require(esm) view). */
    private loadBuiltin(name: string, parent: string): CjsModule {
        const hit = this.builtinCache.get(name);
        if (hit) return hit;

        const info = this.deps.resolveBuiltin(name, parent);
        // Preserve the parent for builtin cycle attribution.
        const ns = this.deps.loadEsmSync(info, parent);

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
        // CJS receives a mutable copy isolated from the ESM namespace.
        const defaultExport = ns.default;
        if ('default' in ns && defaultExport) {
            if (typeof defaultExport === 'function') {
                const target = defaultExport;
                copyMissingExports(target);
                mod.exports = target;
            } else if (typeof defaultExport === 'object') {
                const target = Object.assign({}, defaultExport);
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
            this.execTracked(mod);
            return mod;
        } catch (e) {
            this.cache.delete(path);
            throw e;
        }
    }

    private resolveId(id: string, parentPath: string, inspect = false): ResolvedCjsRequest | null {
        // Older dependency objects fall back to the fetching resolver.
        const external = (req: string, parent: string): ModuleInfo | null =>
            inspect && this.deps.resolveExternalCached
                ? this.deps.resolveExternalCached(req, parent)
                : this.deps.resolveExternal(req, parent);

        // pack:/ctsview: parents have no FS base — full resolver; plain paths stay local-first.
        const runtimeParent = hasProtocolScheme(parentPath)
            ? parentPath
            : this.deps.runtimeParent?.(parentPath) ?? null;
        if (runtimeParent) {
            // resolveExternal rethrows non-miss; do not wrap in empty catch.
            const ext = external(id, runtimeParent);
            if (ext) return { info: ext, isCjs: ext.format === 'cjs' || ext.fileKind === 'json' };
            return null;
        }

        // Let the runtime resolver classify relative and absolute requests first.
        // It has package/source context needed to distinguish local JavaScript ESM
        // from CommonJS. The filesystem fallback below remains for createRequire()
        // contexts that bypass the resolver.
        const ext = external(id, parentPath);
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

        if (ctx.pkg.exports !== undefined) {
            const resolved = resolveExports(ctx, parsed.subpath);
            if (!resolved) throw packagePathNotExportedError(id);
            return this.infoFromLocalPath(resolved.path, resolved.format);
        }

        return this.resolveLocalPath(joinPaths(nodeModulesDir, id));
    }

    private resolveLocalPath(candidate: string): ResolvedCjsRequest | null {
        try {
            const path = normalizePath(resolveFile(normalizePath(candidate)));
            // Require edges classify manifest-less .js as CJS without scanning.
            const format = extname(path) === '.node' ? 'cjs' : detectFormat(path, 'require');
            const fileKind = guessFileKind(path);
            return this.infoFromLocalPath(path, format, fileKind);
        } catch {
            return null;
        }
    }

    private infoFromLocalPath(path: string, format = detectFormat(path, 'require'), fileKind = guessFileKind(path)): ResolvedCjsRequest {
        const info: ModuleInfo = {
            specPath: path,
            localPath: path,
            format,
            fileKind,
        };
        return { info, isCjs: format === 'cjs' || fileKind === 'json' };
    }
}
