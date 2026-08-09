import type { ModuleInfo } from '../types';
import { dirname, joinPaths, isAbsolute, extname, isRelative, resolveFile, safeParse, log, isWindows, hasLeadingSlashDrive, normalizePath, readText, toHostPath as sharedToHostPath, toHostPaths as sharedToHostPaths } from '../utils';
import { err, ErrorKind, requireCycleError } from '../errors';
import { isBuiltinSpecifier } from '../resolve/builtins';
import { guessFileKind } from '../resolve/protocols/base';
import { createCtx, detectFormat, packagePathNotExportedError, resolveExports } from '../resolve/pkg';
import { URL } from '../utils/url';
import { buildCjsWrapperSource, cjsContextSlot, type CjsContext } from './cjs-wrap';
import type { SourceFreshness } from '../source/cache';

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

/**
 * True for a scheme-qualified id like "pack:///0.js" — mirrors resolve/index.ts's protoOf().
 * Kept for parity with protoOf()'s lowercase-only rule; the boundary conversion
 * itself uses hasSchemeId() from utils/path.
 */
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

/**
 * Node's require.resolve() failure, byte-for-byte in shape (measured v24.18.0):
 *   message    "Cannot find module 'x'\nRequire stack:\n- <parent>"
 *   code       'MODULE_NOT_FOUND'
 *   requireStack  ['<parent>']
 * The old message here was "Cannot resolve module 'x'" with no requireStack,
 * so consumers that match on node's wording (bundlers, error reporters) missed.
 */
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

export class CjsLoader {
    // filename → module (includes in-progress modules for circular dep detection)
    readonly cache        = new Map<string, CjsModule>();
    // Modules whose body is on the stack right now. A cache entry alone cannot
    // say this: preRegister() also stores never-executed stubs, and both have
    // loaded === false.
    private readonly executing = new Set<string>();
    // CJS localPath → the ESM module whose static import last resolved it.
    // Only used for "(from X)" attribution in an import-cjs cycle error, where
    // the requirer is an ESM module and so is absent from `executing`.
    // Bounded by the number of distinct CJS files reached from ESM.
    private readonly esmImporters = new Map<string, string>();
    private readonly builtinCache = new Map<string, CjsModule>();
    private mainModule: CjsModule | null = null;
    // require.cache is a plain object; internal store stays a Map.
    // Keys arrive as host paths (require.resolve / module.filename); the store is POSIX.
    private readonly cacheView: Record<string, CjsModule> = new Proxy(Object.create(null), {
        has: (_t, key) => typeof key === 'string' && this.cache.has(normalizePath(key)),
        get: (_t, key) => typeof key === 'string' ? this.cache.get(normalizePath(key)) : undefined,
        set: (_t, key, value) => { if (typeof key === 'string') this.cache.set(normalizePath(key), value); return true; },
        deleteProperty: (_t, key) => { if (typeof key === 'string') this.cache.delete(normalizePath(key)); return true; },
        ownKeys: () => toHostPaths([...this.cache.keys()]),
        getOwnPropertyDescriptor: (_t, key) => {
            if (typeof key !== 'string') return undefined;
            const mod = this.cache.get(normalizePath(key));
            if (!mod) return undefined;
            return { value: mod, writable: true, enumerable: true, configurable: true };
        },
    });

    constructor(private readonly deps: CjsDeps) {}

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

    /** Who to blame in the "(from X)" suffix for an import-cjs cycle.
     *
     *  Node names the *ESM module whose import closed the loop* — measured on
     *  v24.18.0: "Cannot import CommonJS Module ./a.cjs in a cycle. (from
     *  .../b.mjs)". innermostExecuting() structurally cannot produce that: it
     *  only tracks CJS bodies, and the importer is ESM, so it returned the
     *  innermost CJS frame — which in the simple cycle is `filename` itself, i.e.
     *  the module blamed for importing itself.
     *
     *  esmImporters is written by preRegister on every static-ESM resolve of a
     *  CJS file, and QuickJS resolves a module's specifiers immediately before
     *  linking them, so the last writer is the import being linked right now.
     *  Falls back to the old behaviour when nothing was recorded (a cycle reached
     *  without going through the resolve hook). */
    private importCycleFrom(filename: string): string {
        return this.esmImporters.get(normalizePath(filename))
            ?? this.innermostExecuting()
            ?? '<unknown>';
    }

    loadAndGet(filename: string, parentPath?: string, isMain = false): CjsModule {
        filename = normalizePath(filename);
        if (parentPath) parentPath = normalizePath(parentPath);
        const found = this.cache.get(filename);
        // A parent stub carries `loaded: true` but its body has never run and its
        // `require` is the uninitialized placeholder, so it can neither be handed
        // back nor executed in place — drop it and build a real module below.
        const cached = found && (found as InternalCjsModule)[PARENT_STUB] ? undefined : found;
        // In-progress = cycle (ESM importing a CJS module that is requiring it
        // back). Re-running the body would double every side effect and re-enter
        // the ESM module currently being instantiated; Node hands back the
        // partial exports instead.
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
        this.executing.add(filename);
        try { this.exec(mod); }
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
        finally { this.executing.delete(filename); }
        return mod;
    }

    /** Pre-register a module stub so circular deps find it in cache. */
    preRegister(filename: string, parentPath: string): void {
        filename = normalizePath(filename);
        parentPath = normalizePath(parentPath);
        // Record the ESM importer BEFORE the cache-hit return. In the cycle case
        // the file is *already* cached (a CJS require() put it there and its body
        // is on the stack), so anything after the early return never runs — and
        // that is exactly when importCycleError needs the importer's name.
        this.esmImporters.set(filename, parentPath);
        if (this.cache.has(filename)) return;
        let parent = this.cache.get(parentPath);
        if (!parent) {
            // The importer is ESM (only engine.onModule.resolve reaches here, and
            // it fires for static ESM imports), so this stub stands in for a
            // module the CJS loader never owns. Flag it: requireEsm() must not
            // mistake its empty exports for a loaded module and skip the cycle
            // guard — that returned {} where Node throws ERR_REQUIRE_CYCLE_MODULE.
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
                throw err(ErrorKind.Generic, 'Node-API native addons are unavailable in this runtime context',
                    undefined, 'ERR_DLOPEN_FAILED');
            }
            mod.exports = napi.dlopen(filename);
            mod.loaded = true;
        } catch (e) {
            this.cache.delete(filename);
            // ERR_DLOPEN_FAILED is node's code for a .node that won't load
            // (measured: process.dlopen and require() of a bad addon both set
            // it). This is the error sharp collects per load attempt and then
            // reads `.code` off — see the note on codeForKind in errors.ts.
            // Codeless, it crashed sharp's own message builder with
            // "cannot read property 'endsWith' of undefined" and hid which of
            // its ~10 attempts failed.
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
        const sourceFreshness = this.deps.captureSourceFreshness?.(filename);
        let src = readText(filename);
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
            this.cache.delete(filename);
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

        // `inspect: true` on resolveId is the fix for require.resolve() doing
        // network I/O — see ModuleResolver.resolveForInspection for the full
        // reasoning. require() above deliberately keeps the fetching path: only
        // this inspection API changes.
        const resolve = ((id: string, opts?: { paths?: string[] }): string => {
            // Node returns the specifier verbatim for builtins, not a path
            // (measured v24.18.0: resolve('fs') === 'fs',
            // resolve('node:fs') === 'node:fs'). Returning cache/node/fs/index.ts
            // instead made bundlers treat builtins as bundleable files.
            // node:module's _resolveFilename already did this; the global CJS
            // require did not.
            if (isBuiltinSpecifier(id)) return id;
            const searchIn = opts?.paths ? normalizeRequireResolvePaths(opts.paths) : [parentPath];
            for (const p of searchIn) {
                const r = self.resolveId(id, p, true);
                if (r) return toHostPath(r.info.localPath);
            }
            throw moduleNotFoundError(id, parentPath);
        }) as CjsRequireFn['resolve'];
        // Node exposes require.resolve.paths; it was absent here (measured
        // undefined against v24.18.0's function). Returns null for builtins.
        resolve.paths = (id: string): string[] | null => {
            if (isBuiltinSpecifier(id)) return null;
            if (isRelative(id) || isAbsolute(id) || id === '.') return toHostPaths([dirname(parentPath)]);
            return toHostPaths(buildPaths(dirname(parentPath)));
        };
        require.resolve = resolve;
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
        // `parent` is passed through for cycle attribution: loadEsmSync's
        // isInFlight check DOES run for builtins (bridge.ts:112), but without a
        // `from` the resulting ERR_REQUIRE_CYCLE_MODULE reads "<unknown>".
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
            this.execTracked(mod);
            return mod;
        } catch (e) {
            this.cache.delete(path);
            throw e;
        }
    }

    private resolveId(id: string, parentPath: string, inspect = false): ResolvedCjsRequest | null {
        // require.resolve() must not fetch/install (see resolveForInspection).
        // Falls back to resolveExternal when a caller supplied a deps object
        // without the cached twin, so behaviour degrades to "as before" rather
        // than to "resolves nothing".
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

        // CJS relative/absolute require() is anchored to the requiring file.
        // Try the local filesystem path before the generic resolver.
        if (isAbsolute(id)) return this.resolveLocalPath(id);
        if (isRelative(id)) return this.resolveLocalPath(joinPaths(dirname(parentPath), id));
        if (id === '.') return this.resolveLocalPath(dirname(parentPath));

        // External resolver first (covers npm, jsr, http, aliases, import map).
        // Non-miss errors (ProtocolDisabled, Network, …) propagate from resolveExternal.
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
            // .node always CJS; .js uses package type / extension (no source scan).
            // 'require' is load-bearing: every path through here is a require()
            // (or createRequire()) edge, and node classifies a no-manifest `.js`
            // as CJS. Dropping it hands back the import-side ESM default and the
            // child dies on "module is not defined". See detectFormat in pkg.ts.
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
