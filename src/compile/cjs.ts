// compile/cjs.ts — CommonJS compilation engine
//
// Responsibilities:
//   - CjsLoader: build, execute, cache CJS modules
//   - mkRequire() factory
//   - node_modules path traversal
//
// Does NOT contain:
//   - BUILTINS (in resolve/builtins.ts)
//   - CJS/ESM bridge (in compile/bridge.ts)

import type { ModuleInfo } from '../types';
import { dirname, joinPaths, isAbsolute, extname, isRelative, resolveFile, safeParse, log, isWindows } from '../utils';
import { err, ErrorKind } from '../errors';
import { isBuiltinSpecifier } from '../resolve/builtins';
import { guessFileKind } from '../resolve/protocols/base';
import { detectFormat } from '../resolve/pkg';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const napi = import.meta.use('nodeapi');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CjsModule {
    id: string; filename: string; loaded: boolean; exports: any;
    require: CjsRequireFn; children: CjsModule[]; parent: CjsModule | null; paths: string[];
}

export interface CjsRequireFn {
    (id: string): any;
    resolve: (id: string, opts?: { paths?: string[] }) => string;
    cache: Record<string, CjsModule>; main: CjsModule | null;
    extensions: Record<string, (m: CjsModule, f: string) => void>;
}

export interface CjsDeps {
    /** Resolve a node builtin to its concrete module info. */
    resolveBuiltin(name: string, parent: string): ModuleInfo;
    /**
     * Load an ESM module synchronously (for CJS->ESM interop).
     * Must call engine.promiseResult internally; returns the namespace.
     */
    loadEsmSync(info: ModuleInfo): Record<string, any>;
    /** Resolve any external specifier → concrete module info. */
    resolveExternal(req: string, parent: string): ModuleInfo | null;
    /** Prepare source for CJS execution (e.g. strip TS/JSX syntax). */
    prepareSource?(code: string, filePath: string): string | null;
}

interface ResolvedCjsRequest {
    info: ModuleInfo;
    isCjs: boolean;
}

// ---------------------------------------------------------------------------
// Performance: counter-based CJS context keys (no regex), dir-level path cache
// ---------------------------------------------------------------------------

let _ctxId = 0;
const INTERNAL_ID = Symbol('cts.cjs.id');
const INTERNAL_FILENAME = Symbol('cts.cjs.filename');

type InternalCjsModule = CjsModule & {
    [INTERNAL_ID]: string;
    [INTERNAL_FILENAME]: string;
    path?: string;
};

function toHostPath(path: string): string {
    return isWindows && path.includes('/') ? path.replace(/\//g, '\\') : path;
}

function getInternalFilename(mod: CjsModule): string {
    return (mod as InternalCjsModule)[INTERNAL_FILENAME] ?? mod.filename;
}
const _dirPaths = new Map<string, string[]>(); // dir → node_modules search list

export function buildPaths(dir: string): string[] {
    const hit = _dirPaths.get(dir);
    if (hit) return hit;
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

function normalizeCJSExport(obj: any) {
    if (obj !== null && typeof obj === 'object' && !Object.getPrototypeOf(obj)) {
        return { ...obj };
    }
    return obj;
}

function normalizeExecError(error: unknown, filename: string): Error {
    const e = error instanceof Error ? error : new Error(String(error));
    if (e.kind === undefined) {
        e.kind = e instanceof SyntaxError ? ErrorKind.SyntaxError : ErrorKind.Generic;
    }
    if (e instanceof SyntaxError && !(e as any).cause) {
        (e as any).cause = { source: { message: e.message }, path: filename };
    }
    return e;
}

// ---------------------------------------------------------------------------
// CjsLoader
// ---------------------------------------------------------------------------

export class CjsLoader {
    // filename → module (includes in-progress modules for circular dep detection)
    readonly cache        = new Map<string, CjsModule>();
    private readonly builtinCache = new Map<string, CjsModule>();
    // Bracket-indexable view of `cache` for the public require.cache surface —
    // Node's Module._cache/require.cache is a plain object (`cache[path]`),
    // but the internal map stays a real Map for get/set/delete performance.
    private readonly cacheView: Record<string, CjsModule> = new Proxy(Object.create(null), {
        has: (_t, key) => this.cache.has(key as string),
        get: (_t, key) => this.cache.get(key as string),
        set: (_t, key, value) => { this.cache.set(key as string, value); return true; },
        deleteProperty: (_t, key) => { this.cache.delete(key as string); return true; },
        ownKeys: () => [...this.cache.keys()],
        getOwnPropertyDescriptor: (_t, key) => {
            if (!this.cache.has(key as string)) return undefined;
            return { value: this.cache.get(key as string), writable: true, enumerable: true, configurable: true };
        },
    });

    constructor(private readonly deps: CjsDeps) {}

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    loadAndGet(filename: string, parentPath?: string): CjsModule {
        const cached = this.cache.get(filename);
        if (cached?.loaded) return cached;

        const parent = parentPath ? (this.cache.get(parentPath) ?? null) : null;
        const mod    = cached ?? this.make(filename, parent);
        if (!cached) this.cache.set(filename, mod);
        this.exec(mod);
        return mod;
    }

    /** Load CJS source code from a string (for -e / --eval). */
    loadSourceAndGet(code: string, filename: string, parentPath?: string): CjsModule {
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
        if (this.cache.has(filename)) return;
        let parent = this.cache.get(parentPath);
        if (!parent) {
            parent = this.synth(parentPath);
            this.cache.set(parentPath, parent);
        }
        this.cache.set(filename, this.make(filename, parent));
    }

    // -------------------------------------------------------------------------
    // Module construction
    // -------------------------------------------------------------------------

    private make(filename: string, parent: CjsModule | null): CjsModule {
        const dir  = dirname(filename);
        const visibleFilename = toHostPath(filename);
        const mod: InternalCjsModule = {
            id: visibleFilename, filename: visibleFilename, loaded: false,
            exports: Object.create(null),   // plain object, not Object.prototype
            require: null as any,
            children: [], parent,
            paths: buildPaths(dir).map(toHostPath),
            [INTERNAL_ID]: filename,
            [INTERNAL_FILENAME]: filename,
            path: toHostPath(dir),
        };
        mod.require = this.mkRequire(filename, mod);
        if (parent) parent.children.push(mod);
        return mod;
    }

    private synth(filename: string): CjsModule {
        const dir = dirname(filename);
        return {
            id: toHostPath(filename), filename: toHostPath(filename), loaded: true,
            exports: Object.create(null), require: null as any,
            children: [], parent: null, paths: buildPaths(dir).map(toHostPath),
            [INTERNAL_ID]: filename,
            [INTERNAL_FILENAME]: filename,
            path: toHostPath(dir),
        } as InternalCjsModule;
    }

    // -------------------------------------------------------------------------
    // Module execution
    // -------------------------------------------------------------------------

    private exec(mod: CjsModule): void {
        const ext = extname(getInternalFilename(mod));
        if (ext === '.json') { this.execJson(mod); return; }
        if (ext === '.node') {
            this.execNodeAddon(mod);
            return;
        }
        this.execJs(mod);
    }

    private execNodeAddon(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        try {
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
            mod.exports = safeParse(engine.decodeString(fs.readFile(filename)));
            mod.loaded  = true;
        } catch (e) {
            this.cache.delete(filename);
            throw err(ErrorKind.SyntaxError, `JSON parse error in '${filename}': ${e}`, e);
        }
    }

    private execJs(mod: CjsModule): void {
        const filename = getInternalFilename(mod);
        let src = engine.decodeString(fs.readFile(filename));
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
        const key = `__cts${_ctxId++}`;
        const ctx = {
            exports:    mod.exports,
            require:    mod.require,
            module:     mod,
            __filename: mod.filename,
            __dirname:  toHostPath(dirname(filename)),
        };
        Reflect.set(globalThis, key, ctx);

        try {
            const k = JSON.stringify(key);
            const wrapper =
                `(function(exports,require,module,__filename,__dirname){${src}\n})` +
                `.call(globalThis[${k}].exports,` +
                `globalThis[${k}].exports,` +
                `globalThis[${k}].require,` +
                `globalThis[${k}].module,` +
                `globalThis[${k}].__filename,` +
                `globalThis[${k}].__dirname);`;
            engine.eval(wrapper, filename,
                engine.EVAL_NEW_BACKTRACE | engine.EVAL_GLOBAL);
            mod.loaded = true;
        } catch (e) {
            this.cache.delete(filename);
            log.debug('cjs', () => `eval error: ${filename}`, e);
            throw normalizeExecError(e, filename);
        } finally {
            Reflect.deleteProperty(globalThis, key);
        }
    }

    // -------------------------------------------------------------------------
    // require() factory
    // -------------------------------------------------------------------------

    public mkRequire(parentPath: string, parentMod: CjsModule | null = null): CjsRequireFn {
        const self = this;

        function require(id: string): any {
            // 1. Node built-ins
            const bare = id.startsWith('node:') ? id.slice(5) : id;
            if (isBuiltinSpecifier(id)) return self.loadBuiltin(bare, parentPath).exports;

            // 2. Resolve
            const resolved = self.resolveId(id, parentPath);
            if (!resolved) throw err(ErrorKind.ModuleNotFound, `Cannot find module '${id}' from '${parentPath}'`);

            const { info, isCjs } = resolved;
            const path = info.localPath;
            log.debug('cjs', () => `require('${id}') → ${path} isCjs=${isCjs}`);

            // 3. CJS → ESM interop: if resolved is ESM, load it via ESM pipeline
            if (!isCjs) {
                return self.requireEsm(info, parentPath);
            }

            // 4. Cache hit (includes in-progress = circular dep → return partial exports)
            const hit = self.cache.get(path);
            if (hit) return hit.exports; // may be partial for circular deps

            // 5. Load CJS
            return self.loadResolvedCjs(path, parentMod).exports;
        }

        require.resolve = function(id: string, opts?: { paths?: string[] }): string {
            const searchIn = opts?.paths ?? [parentPath];
            for (const p of searchIn) {
                const r = self.resolveId(id, p);
                if (r) return toHostPath(r.info.localPath);
            }
            throw err(ErrorKind.ModuleNotFound, `Cannot resolve module '${id}'`);
        };
        require.cache      = self.cacheView;
        require.main       = null;
        require.extensions = {
            '.js':   (m: CjsModule) => self.execJs(m),
            '.json': (m: CjsModule) => self.execJson(m),
            '.node': (m: CjsModule) => self.execNodeAddon(m),
        };
        return require as CjsRequireFn;
    }

    // -------------------------------------------------------------------------
    // CJS → ESM interop
    // -------------------------------------------------------------------------

    /**
     * CJS → ESM interop: synchronously load an ESM module.
     * Uses deps.loadEsmSync which handles promiseResult semantics.
     * Cached in the same map (keyed by localPath) as plain CJS modules so
     * repeated require() calls return the same object AND the module shows
     * up in require.cache, matching Node 22+ require(esm) semantics.
     */
    private requireEsm(info: ModuleInfo, parentPath: string): any {
        const path = info.localPath;
        const hit = this.cache.get(path);
        if (hit) return hit.exports;

        // Native addons (.node) must go through CJS exec path, not ESM compile
        if (extname(path) === '.node') {
            const mod = this.loadAndGet(path, parentPath);
            return mod.exports;
        }

        const result = this.deps.loadEsmSync(info);
        const mod = this.synth(path);
        mod.exports = normalizeCJSExport('default' in result ? result['default'] : result);
        this.cache.set(path, mod);
        return mod.exports;
    }

    /**
     * Load a node builtin module (e.g. 'fs', 'path').
     * Delegates to deps for resolution + ESM loading,
     * then applies ns.default logic (same as requireEsm).
     */
    private loadBuiltin(name: string, parent: string): CjsModule {
        const hit = this.builtinCache.get(name);
        if (hit) return hit;

        const info = this.deps.resolveBuiltin(name, parent);
        const ns = this.deps.loadEsmSync(info);

        const mod = this.synth(info.localPath);
        const copyMissingExports = (target: any) => {
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
        if ('default' in ns && ns.default) {
            if (typeof ns.default === 'function') {
                mod.exports = ns.default;
                copyMissingExports(mod.exports);
            } else if (typeof ns.default === 'object') {
                mod.exports = Object.isExtensible(ns.default)
                    ? ns.default
                    : Object.assign({}, ns.default);
                copyMissingExports(mod.exports);
            } else {
                mod.exports = ns.default;
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

    // -------------------------------------------------------------------------
    // Module resolution
    // -------------------------------------------------------------------------

    private resolveId(id: string, parentPath: string): ResolvedCjsRequest | null {
        // External resolver first (covers npm, jsr, http, aliases, import map)
        try {
            const ext = this.deps.resolveExternal(id, parentPath);
            if (ext) {
                return {
                    info: ext,
                    isCjs: ext.format === 'cjs' || ext.fileKind === 'json',
                };
            }
        } catch {}

        // Local filesystem fallback for contexts that bypass the resolver, such as
        // internal createRequire() consumers operating directly on filenames.
        if (isAbsolute(id)) return this.resolveLocalPath(id);
        if (isRelative(id)) return this.resolveLocalPath(joinPaths(dirname(parentPath), id));
        if (id === '.') return this.resolveLocalPath(dirname(parentPath));
        for (const dir of buildPaths(dirname(parentPath))) {
            const resolved = this.resolveLocalPath(joinPaths(dir, id));
            if (resolved) return resolved;
        }
        return null;
    }

    private resolveLocalPath(candidate: string): ResolvedCjsRequest | null {
        try {
            const path = resolveFile(candidate);
            // .node/.json always load through the CJS path below; for .js/.mjs/.cjs
            // honor the nearest package.json "type" field like the external resolver
            // does, otherwise an ESM file reached via a bare relative require() would
            // be fed straight into the CJS eval and crash on `export`/`import` syntax.
            const format = extname(path) === '.node' ? 'cjs' : detectFormat(path);
            const fileKind = guessFileKind(path);
            const info: ModuleInfo = {
                specPath: path,
                localPath: path,
                format,
                fileKind,
            };
            return { info, isCjs: format === 'cjs' || fileKind === 'json' };
        } catch {
            return null;
        }
    }
}
