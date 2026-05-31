# cts2 — project reference for AI

## Runtime environment

cts2 runs inside **circu.js**, a QuickJS-based JavaScript engine. Key differences from Node.js:

- No built-in `require`, `process`, `Buffer` — these come from polyfills
- Modules are accessed via `useFn('name')` in `src/utils/index.ts` (synchronous, returns a namespace object)
- The engine is single-threaded; async/await works via the QuickJS event loop
- `engine.eval()` is synchronous for non-async code; `engine.promiseResult()` extracts already-resolved promises synchronously
- Workers exist (`useFn('worker')`) but are separate OS threads with message-passing only
- No `require()` at the top level — everything is ESM by design

Common engine modules used: `fs`, `engine`, `os`, `sys`, `streams`, `asyncfs`, `process`, `worker`, `wasm`, `sourcemap`, `crypto`, `curl`, `dns`, `ssl`, `timers`, `zlib`

## Architecture overview

```
main.ts
  ├─ config.ts          CLI parsing, env vars, tsconfig/deno.json loading
  └─ runtime.ts         Engine hook setup, entry/polyfill loading
       ├─ resolver.ts   Specifier → ModuleInfo (three-level cache + lock)
       │    └─ protocol/   One handler per protocol
       │         file / data / http / https / jsr / npm / node
       ├─ loader.ts     ModuleInfo → engine.Module (ESM, CJS, WASM, bytes, text)
       │    ├─ transformer.ts   TS/JSX → JS via Sucrase
       │    └─ cjs.ts          CommonJS module system
       ├─ lock.ts       Persistent resolution cache (cts.lock)
       ├─ deps.ts       Parallel async dep scanner (cts cache)
       └─ resources.ts  Lifecycle: release curl/connections/caches before user code
```

Supporting files: `pkg.ts` (package.json utilities), `errors.ts` (user-facing error formatting), `task.ts` (deno.json task runner), `types.ts` (all shared types).

## Core data flow

### Engine hooks (runtime.ts)

The engine calls three hooks for every `import`:

1. **`resolve(spec, parent, attr)`** → returns a string `specPath`
2. **`load(specPath)`** → returns a `CModuleEngine.Module`
3. **`init(specPath, importMeta)`** → populates `import.meta.*`

`runtime.ts` wires these to `resolver.resolve()` and `loader.load()`.

### ModuleInfo — the central type

```ts
interface ModuleInfo {
    specPath:  string;       // canonical engine identifier, e.g. "jsr:@std/http@1.0.0/server.ts"
    localPath: string;       // actual file on disk, e.g. "~/.cts/jsr/std/http/1.0.0/server.ts"
    format:    'esm'|'cjs'; // how to execute it
    fileKind:  'source'|'json'|'wasm'|'binary';
}
```

`ModuleInfo` is produced by `resolver.resolve()` and consumed by `loader.load()`. It replaces the original codebase's scattered `ResolveResult`/`LocalPathResult`/`moduleTypeMap` triple.

### Resolution — three-level cache

`resolver.resolve(spec, parent, attr)`:

1. **L1 — source index**: `lock.sources["spec\0parent"]` → specPath → `lock.modules[specPath]`. Skips import map + dispatch entirely. Populated from `cts.lock`.
2. **L2 — module index**: For canonical specifiers (with explicit protocol), checks `lock.modules[spec]` directly. Skips protocol handler.
3. **L3 — dispatch**: Calls the appropriate `ProtocolHandler.resolve()`. Downloads if needed. Result is stored in both indexes for next run.

The `LockStore` is the single in-process cache — `lock.modules` holds all `ModuleInfo` objects; `lock.sources` maps `(spec, parent)` pairs to specPaths.

## Protocol handlers (`src/protocol/`)

Each handler implements:
```ts
interface ProtocolHandler {
    protocols: string[];                                   // e.g. ['http','https']
    resolve(spec, parent, attr?): ModuleInfo;              // download if needed, return info
    localPath(specPath: string): string;                   // fast re-derive local path
}
```

| Handler | Protocols | Key behavior |
|---------|-----------|--------------|
| `FileHandler` | `file` | Strips `file://`, stat check, detectFormat |
| `HttpHandler` | `http`,`https` | Downloads to `cacheDir/http/<host>/<hash>`, keeps `urlMap` |
| `JsrHandler` | `jsr` | Fetches registry metadata with TTL, downloads individual files |
| `NpmHandler` | `npm` | Reads `.npmrc`, fetches metadata, downloads+extracts tarball |
| `NodeHandler` | `node` | Resolves to `cacheDir/node/<name>/index.ts` polyfill path |
| `DataHandler` | `data` | Decodes base64/URI, writes to `cacheDir/data/<hash>.<ext>` |

## Lock file (`src/lock.ts`)

Format: NDJSON, two entry types:
```
// cts.lock v2
{"s":"specPath","l":"localPath","f":"esm","k":"source"}   ← module entry
{"q":"spec\0parent","v":"specPath"}                        ← source entry
```

- **Load**: all lines wrapped in `[...]` and parsed with a single `JSON.parse()` call
- **Flush** (program exit): append-only via `fs.open('a')` — never reads back existing file
- **Rewrite** (`cts cache`): full sorted dedup, called after dep scan

Stale entries (remote module whose `localPath` no longer exists) are silently skipped on load.

## ESM / CJS interop (`src/loader.ts`, `src/cjs.ts`)

### ESM imports CJS (`loader.loadCjs`)
- Detect `exports.__esModule === true` (Babel/tsc transpiled): `default` = `exports.default`, named = other keys
- Otherwise (true CJS): `default` = whole `module.exports`, named = each enumerable key

### CJS requires ESM (`cjs.requireEsm`)
- Calls `deps.loadEsmSync()` → `loadEsm()` + `engine.promiseResult(mod.eval())`
- Returns `ns.default` if present, full namespace otherwise
- Result cached in `builtinCache` to avoid re-evaluation

### CJS requires node: builtin (`cjs.loadBuiltin`)
- Resolves polyfill path via `deps.builtinToPath()`
- Loads as ESM, merges `ns.default` own properties so destructuring works:
  ```ts
  const { readFileSync } = require('fs'); // works
  ```

### CJS wrapper
Each CJS file is wrapped:
```js
const global=globalThis,{exports,require,module,__filename,__dirname}=globalThis[KEY];
<source>
```
`KEY` is a counter string `__cts0`, `__cts1`, … (no regex). Context is injected via `globalThis[KEY]` and deleted in `finally`.

## Transformer (`src/transformer.ts`)

Uses Sucrase (`deps/sucrase/src/index.ts`) with `disableESTransforms: true` (keeps `import`/`export` syntax). Handles `.ts`, `.tsx`, `.jsx`, `.json`. Source maps loaded via `smap.load()`.

## Dep scanner (`src/deps.ts`)

Parallel BFS using libcurl (`src/utils/curl.ts`):

1. Parse level N files concurrently with `asyncfs.readFile()` + sucrase tokenizer
2. Resolve specifiers via `resolver.resolve()` — already-cached files enqueue for level N+1
3. Uncached remote files (JSR/HTTP) fetched in parallel with `Promise.allSettled()` + `fetchAsync()`
4. Newly downloaded files become level N+1 batch

Import extraction (`extractImports`) uses sucrase's token stream directly — no `TokenProcessor`/`HelperManager` needed, just `source.slice(tok.start+1, tok.end-1)`.

## Resource lifecycle (`src/resources.ts`)

Pre-registered cleanups run in LIFO order before user code starts:
1. `closePool()` — libcurl async connection pool
2. `connectionManager.closeAll()` — sync HTTP keep-alive pool
3. `clearPkgCache()` — package.json / format / exports caches
4. `clearResolveCache()` — file resolution LRU cache

`resources.release()` is called in `runtime.precache()` finally block AND at the start of `runtime.loadEntry()` — idempotent.

## Caches and their bounds

| Cache | Location | Bound | Eviction |
|-------|----------|-------|----------|
| `pkgCache` | `pkg.ts` | LRU(512) | LRU + 5min TTL |
| `formatCache` | `pkg.ts` | LRU(2048) | LRU |
| `formatDirCache` | `pkg.ts` | LRU(512) | LRU |
| `exportsCache` | `pkg.ts` | LRU(1024) | LRU |
| `resolveCache` | `utils/io.ts` | LRU(2048) | LRU |
| `lock.modules` | `lock.ts` | unbounded | on disk, cleared by `cts cache` |
| `lock.sources` | `lock.ts` | unbounded | on disk, cleared by `cts cache` |
| `esmCache` | `loader.ts` | unbounded* | cleared when runtime is GC'd |
| `_dirPaths` | `cjs.ts` | unbounded* | process-scoped |

*These are bounded by the number of modules in a single run.

## Key files and their roles

| File | Role |
|------|------|
| `main.ts` | CLI entry: parse args, subcommands (run/cache/task), help/version |
| `src/types.ts` | All shared TypeScript interfaces. `ModuleInfo` is the key type. |
| `src/config.ts` | `createConfig()` merges CLI+env+file config. `loadConfigFile()` reads tsconfig/deno.json. Exports `CLI_TPL` for unknown-flag detection. |
| `src/runtime.ts` | `TypeScriptRuntime`: wires engine hooks, owns `fillMeta()`, calls `precache()`/`loadEntry()`. |
| `src/resolver.ts` | `ModuleResolver`: three-level cache, import map index, path alias index, dispatches to protocol handlers. |
| `src/loader.ts` | `ModuleLoader`: ESM/CJS/WASM/bytes/text loading, JSC cache, CjsDeps bridge. |
| `src/cjs.ts` | `CjsLoader`: full CommonJS runtime with ESM interop, counter-based context keys, dir-level path cache. |
| `src/lock.ts` | `LockStore`: NDJSON lock file, single-parse load, append-only flush. |
| `src/deps.ts` | `DepScanner`: parallel BFS dep scanner used by `cts cache` and `--precache`. |
| `src/pkg.ts` | `readPkg`, `detectFormat`, `resolveExports`, `resolveSubpath` — all with LRU caches. |
| `src/errors.ts` | `formatError(e, context)` and `fatal(e)`: classified errors with suggestions, colour, source context. |
| `src/task.ts` | `TaskRunner`: deno.json task execution, `deno run` rewriting, dep graph. |
| `src/resources.ts` | LIFO cleanup registry. Pre-registers curl/connection/cache teardowns. |
| `src/transformer.ts` | Sucrase wrapper: TS/JSX → JS, source map registration. |
| `src/utils/log.ts` | Lazy-eval debug logger gated by `DEBUG` env var. Zero cost when disabled. |
| `src/utils/lru.ts` | Map-backed O(1) LRU cache used by all bounded caches. |
| `src/utils/net.ts` | Sync HTTP via circu.js TCP stack. Used by protocol handlers during module load. |
| `src/utils/curl.ts` | Async HTTP via libcurl. Only used by `DepScanner`. 8 total / 4 per host. |
| `src/utils/progress.ts` | Multi-line TTY progress display for parallel downloads. |
| `src/protocol/` | One file per protocol. All follow the `ProtocolHandler` interface. |
| `src/http/` | Low-level HTTP: `connection.ts` (keep-alive pool), `http.ts` (builder/parser), `url.ts` (URL class). |
| `deps/sucrase/` | Bundled Sucrase source. Used by transformer and dep scanner. Do not modify. |

## Conventions

- `import.meta.use('module')` always at top-level, assigned to `const`
- `log.debug('category', () => \`lazy string\`)` — lambda prevents string alloc when disabled
- Protocol handlers never call each other; routing goes through `ModuleResolver`
- `CjsDeps` interface: the bridge between `CjsLoader` and `ModuleLoader`. All three methods are synchronous.
- `ProtocolHandler.resolve()` is called at most once per unique specifier per run (L3 cache miss only)
- `ensureDir()` before any `fs.writeFile()` to a new path
- `fs.open('a')` for append writes; never read-then-write for lock flush
