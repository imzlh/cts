// cjs.ts — CommonJS module system with correct ESM interop
//
// ESM/CJS interop rules (matches Node.js behaviour):
//   ESM imports CJS  → CJS module.exports becomes `default`; named keys also exported
//   ESM imports CJS with __esModule=true → treat as transpiled ESM: use .default as default
//   CJS requires ESM → synchronously extract ESM namespace via engine.promiseResult
//   CJS requires CJS → normal require() chain
//   Circular CJS     → return partial exports (same as Node.js)
//   Circular ESM→CJS→ESM → return empty namespace with warning

import { dirname, joinPaths, isAbsolute, extname } from './utils/path';
import { resolveFile } from './utils/io';
import { safeParse } from './utils/misc';
import { detectFormat, resolveMain, createCtx } from './pkg';
import { log } from './utils/log';
import { fs, engine } from './utils/index';
import { err, ErrorKind } from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CjsModule {
    id: string; filename: string; loaded: boolean; exports: any;
    require: CjsRequireFn; children: CjsModule[]; parent: CjsModule | null; paths: string[];
}

interface CjsRequireFn {
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
    /** Resolve any external specifier → { path, isCjs }. */
    resolveExternal(req: string, parent: string): { path: string; isCjs: boolean } | null;
}

// ---------------------------------------------------------------------------
// Built-in module names (no protocol prefix)
// ---------------------------------------------------------------------------

export const BUILTINS = new Set([
    'assert','buffer','child_process','cluster','console','constants',
    'crypto','dgram','dns','domain','events','fs','http','http2','https',
    'module','net','os','path','perf_hooks','process','punycode',
    'querystring','readline','repl','stream','string_decoder',
    'timers','tls','trace_events','tty','url','util','v8','vm',
    'worker_threads','zlib',
]);

// ---------------------------------------------------------------------------
// Performance: counter-based CJS context keys (no regex), dir-level path cache
// ---------------------------------------------------------------------------

let _ctxId = 0;
const _dirPaths = new Map<string, string[]>(); // dir → node_modules search list

function buildPaths(dir: string): string[] {
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
    // modules currently executing (for circular dep detection)
    private readonly loading = new Set<string>();
    private readonly builtinCache = new Map<string, CjsModule>();

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
        if (ext === '.node') throw err(ErrorKind.ModuleNotFound, `Native (.node) modules not supported: ${mod.filename}`);
        this.execJs(mod);
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
        this.loading.add(mod.filename);

        try {
            const wrapper =
                `const global=globalThis,{exports,require,module,__filename,__dirname}` +
                `=globalThis[${JSON.stringify(key)}];\n${src}`;
            engine.eval(wrapper, mod.filename,
                engine.EVAL_NEW_BACKTRACE | engine.EVAL_MODULE);
            mod.loaded = true;
            log.debug('cjs', () => `loaded: ${mod.filename}`);
        } catch (e) {
            this.cache.delete(mod.filename);
            throw err(ErrorKind.Generic, `Error loading '${mod.filename}': ${e}`);
        } finally {
            Reflect.deleteProperty(globalThis, key);
            this.loading.delete(mod.filename);
        }
    }

    // -------------------------------------------------------------------------
    // require() factory
    // -------------------------------------------------------------------------

    public mkRequire(parentPath: string, parentMod: CjsModule): CjsRequireFn {
        const self = this;

        function require(id: string): any {
            // 1. Node built-ins
            const bare = id.startsWith('node:') ? id.slice(5) : id;
            if (BUILTINS.has(bare)) return self.loadBuiltin(bare, parentPath).exports;

            // 2. Resolve
            const resolved = self.resolveId(id, parentPath);
            if (!resolved) throw err(ErrorKind.ModuleNotFound, `Cannot find module '${id}' from '${parentPath}'`);

            const { path, isCjs } = resolved;

            // 3. CJS → ESM interop: if resolved is ESM, load it via ESM pipeline
            if (!isCjs) {
                return self.requireEsm(path, id, parentPath);
            }

            // 4. Cache hit (includes in-progress = circular dep → return partial exports)
            const hit = self.cache.get(path);
            if (hit) return hit.exports; // may be partial for circular deps

            // 5. Load CJS
            const mod = self.make(path, parentMod);
            self.cache.set(path, mod);
            self.loading.add(path);
            try { self.exec(mod); }
            catch (e) { self.cache.delete(path); throw e; }
            finally { self.loading.delete(path); }
            return mod.exports;
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
        } as any;
        return require as CjsRequireFn;
    }

    /**
     * CJS → ESM interop: synchronously load an ESM module and return its
     * `exports`-compatible object.
     *
     * Returns `ns.default ?? ns` so that `require('esm-package')` behaves like
     * Node.js: packages that export a single default get it directly, while
     * packages with only named exports return the namespace.
     *
     * The result is cached so repeated require() calls return the same object.
     */
    private requireEsm(localPath: string, specifier: string, parentPath: string): any {
        const cacheKey = `__esm__${localPath}`;
        const hit = this.builtinCache.get(cacheKey);
        if (hit) return hit.exports;

        const specPath = localPath;

        const ns = this.deps.loadEsmSync(localPath, specPath);

        // Synthesise a CJS-compatible exports object that mirrors the ESM namespace.
        // Node.js compat: require('esm-pkg') returns ns.default when present,
        // otherwise the full namespace (named exports accessible as ns.foo).
        const synthetic = Object.assign(Object.create(null), ns);
        const result = 'default' in ns ? ns.default : synthetic;
        const mod = this.synth(localPath);
        mod.exports = result;
        this.builtinCache.set(cacheKey, mod);
        return result;
    }

    // -------------------------------------------------------------------------
    // Built-in / polyfill loading
    // -------------------------------------------------------------------------

    private loadBuiltin(name: string, parent: string): CjsModule {
        const hit = this.builtinCache.get(name);
        if (hit) return hit;

        const localPath = this.deps.builtinToPath(name, parent);
        const ns        = this.deps.loadEsmSync(localPath, `node:${name}`);

        const mod = this.synth(localPath);
        // Builtins: spread named exports, keep default as the default export
        mod.exports = Object.assign(Object.create(null), ns);
        if ('default' in ns && typeof ns.default === 'object' && ns.default !== null) {
            // Merge default's own properties so `const { readFileSync } = require('fs')` works
            Object.assign(mod.exports, ns.default);
        }
        this.builtinCache.set(name, mod);
        return mod;
    }

    // -------------------------------------------------------------------------
    // Module resolution
    // -------------------------------------------------------------------------

    private resolveId(id: string, parentPath: string): { path: string; isCjs: boolean } | null {
        // External resolver first (covers npm, jsr, http, aliases, import map)
        try {
            const ext = this.deps.resolveExternal(id, parentPath);
            if (ext) return ext;
        } catch {}

        // Absolute path
        if (isAbsolute(id)) {
            try {
                const path = resolveFile(id);
                return { path, isCjs: detectFormat(path) === 'cjs' };
            } catch { return null; }
        }

        // Relative path
        if (id.startsWith('./') || id.startsWith('../')) {
            const base = joinPaths(dirname(parentPath), id);
            try {
                const path = resolveFile(base);
                return { path, isCjs: detectFormat(path) === 'cjs' };
            } catch { return null; }
        }

        // require('.') — resolve to the package's main entry (package.json "main"),
        // falling back to directory index (index.js etc.) if no package.json exists.
        if (id === '.') {
            const dir = dirname(parentPath);
            try {
                const ctx = createCtx(dir);
                const mainPath = ctx ? resolveMain(ctx) : null;
                const path = mainPath ?? resolveFile(dir);
                return { path, isCjs: detectFormat(path) === 'cjs' };
            } catch { return null; }
        }

        // node_modules walk
        for (const dir of buildPaths(dirname(parentPath))) {
            try {
                const path = resolveFile(joinPaths(dir, id));
                return { path, isCjs: detectFormat(path) === 'cjs' };
            } catch {}
        }
        return null;
    }
}
