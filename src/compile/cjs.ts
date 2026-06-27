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

import { dirname, joinPaths, isAbsolute, extname, isRelative } from '../utils/path';
import { resolveFile } from '../utils/io';
import { safeParse } from '../utils/misc';
import { log } from '../utils/log';
import { err, ErrorKind } from '../errors';
import { isBuiltinSpecifier } from '../resolve/builtins';

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
    cache: Map<string, CjsModule>; main: CjsModule | null;
    extensions: Record<string, (m: CjsModule, f: string) => void>;
}

export interface CjsDeps {
    /** Resolve a node: builtin name → local polyfill path. */
    builtinToPath(name: string, parent: string): string;
    /**
     * Load an ESM module synchronously (for CJS->ESM interop).
     * Must call engine.promiseResult internally; returns the namespace.
     */
    loadEsmSync(localPath: string, specPath: string): Record<string, any>;
    /** Resolve any external specifier → canonical/local path pair + format. */
    resolveExternal(req: string, parent: string): { path: string; specPath: string; isCjs: boolean } | null;
    /** Prepare source for CJS execution (e.g. strip TS/JSX syntax). */
    prepareSource?(code: string, filePath: string): string | null;
}

interface ResolvedCjsRequest {
    path: string;
    specPath: string;
    isCjs: boolean;
}

// ---------------------------------------------------------------------------
// Performance: counter-based CJS context keys (no regex), dir-level path cache
// ---------------------------------------------------------------------------

let _ctxId = 0;
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

// ---------------------------------------------------------------------------
// CjsLoader
// ---------------------------------------------------------------------------

export class CjsLoader {
    // filename → module (includes in-progress modules for circular dep detection)
    readonly cache        = new Map<string, CjsModule>();
    private readonly builtinCache = new Map<string, CjsModule>();
    private readonly esmInteropCache = new Map<string, CjsModule>();

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
        const mod: CjsModule = {
            id: filename, filename, loaded: false,
            exports: Object.create(null),   // plain object, not Object.prototype
            require: null as any,
            children: [], parent,
            paths: buildPaths(dir),
        };
        mod.require = this.mkRequire(filename, mod);
        if (parent) parent.children.push(mod);
        return mod;
    }

    private synth(filename: string): CjsModule {
        return {
            id: filename, filename, loaded: true,
            exports: Object.create(null), require: null as any,
            children: [], parent: null, paths: buildPaths(dirname(filename)),
        };
    }

    // -------------------------------------------------------------------------
    // Module execution
    // -------------------------------------------------------------------------

    private exec(mod: CjsModule): void {
        const ext = extname(mod.filename);
        if (ext === '.json') { this.execJson(mod); return; }
        if (ext === '.node') {
            this.execNodeAddon(mod);
            return;
        }
        this.execJs(mod);
    }

    private execNodeAddon(mod: CjsModule): void {
        try {
            mod.exports = napi.dlopen(mod.filename);
            mod.loaded = true;
        } catch (e) {
            this.cache.delete(mod.filename);
            throw err(ErrorKind.Generic, `Error loading native addon '${mod.filename}': ${e}`);
        }
    }

    private execJson(mod: CjsModule): void {
        try {
            mod.exports = safeParse(engine.decodeString(fs.readFile(mod.filename)));
            mod.loaded  = true;
        } catch (e) {
            this.cache.delete(mod.filename);
            throw err(ErrorKind.SyntaxError, `JSON parse error in '${mod.filename}': ${e}`);
        }
    }

    private execJs(mod: CjsModule): void {
        let src = engine.decodeString(fs.readFile(mod.filename));
        // Transform TS/ESM source for CJS execution if a transformer is available
        if (this.deps.prepareSource) {
            const transformed = this.deps.prepareSource(src, mod.filename);
            if (transformed !== null) src = transformed;
        }
        this.execWithSource(mod, src);
    }

    private execWithSource(mod: CjsModule, src: string): void {
        if (src.startsWith('#!')) src = src.slice(src.indexOf('\n'));

        const key = `__cts${_ctxId++}`;
        const ctx = {
            exports:    mod.exports,
            require:    mod.require,
            module:     mod,
            __filename: mod.filename,
            __dirname:  dirname(mod.filename),
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
            engine.eval(wrapper, mod.filename,
                engine.EVAL_NEW_BACKTRACE | engine.EVAL_GLOBAL);
            mod.loaded = true;
        } catch (e) {
            this.cache.delete(mod.filename);
            log.debug('cjs', () => `eval error: ${mod.filename}`, e);
            throw err(ErrorKind.Generic, `Error loading '${mod.filename}': ${e}`);
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

            const { path, specPath, isCjs } = resolved;
            log.debug('cjs', () => `require('${id}') → ${path} isCjs=${isCjs}`);

            // 3. CJS → ESM interop: if resolved is ESM, load it via ESM pipeline
            if (!isCjs) {
                return self.requireEsm(path, specPath, parentPath);
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
                if (r) return r.path;
            }
            throw err(ErrorKind.ModuleNotFound, `Cannot resolve module '${id}'`);
        };
        require.cache      = self.cache;
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
     * Result cached so repeated require() calls return the same object.
     */
    private requireEsm(localPath: string, specPath: string, parentPath: string): any {
        const cacheKey = `__esm__${localPath}`;
        const hit = this.esmInteropCache.get(cacheKey);
        if (hit) return hit.exports;

        // Native addons (.node) must go through CJS exec path, not ESM compile
        if (extname(localPath) === '.node') {
            const mod = this.loadAndGet(localPath, parentPath);
            return mod.exports;
        }

        const result = this.deps.loadEsmSync(localPath, specPath);
        const mod = this.synth(localPath);
        mod.exports = 'default' in result ? result['default'] : Object(result);
        this.esmInteropCache.set(cacheKey, mod);
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

        const localPath = this.deps.builtinToPath(name, parent);
        const ns = this.deps.loadEsmSync(localPath, `node:${name}`);

        const mod = this.synth(localPath);
        // Builtins: spread named exports, keep default as the default export
        mod.exports = Object.assign(Object.create(null), ns);
        if ('default' in ns && ns.default) {
            if (typeof ns.default === 'object') {
                Object.assign(mod.exports, ns.default);
            } else if (typeof ns.default === 'function') {
                mod.exports = ns.default;
                for (const k of Object.keys(ns)) {
                    if (k !== 'default') (mod.exports as any)[k] = ns[k];
                }
            }
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
            if (ext) return ext;
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
            return { path, specPath: path, isCjs: true };
        } catch {
            return null;
        }
    }
}
