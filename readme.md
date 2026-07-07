# cts

`cts` is the TypeScript loader used by `cno-cli`. It resolves modules, reads and
transforms source, compiles modules for `circu.js`, and maintains the resolution
lock/cache used by `cno cache` and `cno run`.

It is not the Web/Deno/Node polyfill layer. Those APIs live in `../cno`.

## Main Responsibilities

- Resolve `file:`, `npm:`, `jsr:`, `http:`, `https:`, `node:`, and `data:`
  specifiers.
- Apply import maps, TypeScript path aliases, package exports/imports, and
  Node builtin aliases.
- Transform TypeScript, TSX, JSX, and CommonJS/ESM bridge code.
- Load ESM, CJS, JSON, text, binary, and WASM modules.
- Cache transformed bytecode under the CTS cache directory.
- Maintain `cts.lock` as a resolution cache.
- Pre-scan dependency graphs for `cno cache`.

## Architecture

```text
api/
  public exports used by cno-cli

runtime/
  TypeScriptRuntime composition root
  installs engine hooks and owns resolver/compiler/resources

resolve/
  ModuleResolver and protocol handlers
  produces ModuleInfo records

source/
  source reading, transform, bytecode cache

compile/
  ESM compiler, CJS loader, CJS/ESM bridge, WASM loader
```

The hot path for a normal run is:

```text
createRuntime()
  -> ModuleResolver.resolve(entry)
  -> ModuleCompiler.load(info)
  -> engine.Module evaluation
```

The hot path for cache preparation is:

```text
TypeScriptRuntime.runPrecache()
  -> DepScanner
  -> ModuleResolver.resolveAsync()
  -> optional node_modules materialization
  -> optional npm lifecycle scripts
  -> ParseDriver.compileModules()
```

## Key Files

| File | Purpose |
| --- | --- |
| `src/api/index.ts` | Public API barrel for the CLI |
| `src/runtime/index.ts` | Runtime composition, lock target selection, precache lifecycle |
| `src/runtime/hooks.ts` | `engine.onModule()` hook installation |
| `src/resolve/index.ts` | Main resolver and three-level cache |
| `src/resolve/protocols/npm.ts` | npm package download/cache handling |
| `src/resolve/protocols/node.ts` | Node builtin polyfill resolution |
| `src/resolve/linker.ts` | `--npm-mode` node_modules materialization |
| `src/source/transform.ts` | OXC/Sucrase transform boundary and diagnostics |
| `src/compile/index.ts` | ModuleCompiler facade |
| `src/compile/esm.ts` | ESM loading and bytecode cache use |
| `src/compile/cjs.ts` | CommonJS execution and `require()` |
| `src/compile/bridge.ts` | CJS/ESM interop |
| `src/deps.ts` | Dependency scanner used by precache |
| `src/parse.ts` | Worker-backed scan/compile driver |
| `src/config.ts` | Config, env, CLI, and cache directory setup |
| `src/lock.ts` | SQLite-backed lock store |

## Resolution Cache

`ModuleResolver` uses three resolution layers:

```text
L1: source key -> specPath
L2: specPath -> ModuleInfo
L3: protocol handler dispatch
```

The lock is a cache of resolution results, not a package manager lockfile. Only
`cno cache` persists it by default. Runtime commands open it read-only when it
exists.

## Configuration Priority

Runtime config is assembled from:

```text
defaults
  -> environment variables
  -> caller-provided config
  -> CLI flags parsed from os.args
```

`loadConfigFile()` also reads nearby `tsconfig.json`, `deno.json`,
`deno.jsonc`, and `package.json` for import maps, path aliases, and
`cts.nodeModulesMode`.

Useful environment variables:

```text
CTS_CACHE_DIR
CTS_LOCK_DIR
CTS_DISABLE_CACHE
CTS_ENABLE_HTTP
CTS_ENABLE_JSR
CTS_ENABLE_NODE
CTS_ENABLE_OXC
CTS_NO_OXC
CTS_SILENT
CTS_MEMORY_LIMIT
CTS_MAX_STACK_SIZE
CTS_WORKERS
NPM_CONFIG_REGISTRY
NPM_TOKEN
```

## OXC And Sucrase

When enabled, CTS tries to load the `oxc` native extension. OXC is used for
fast import scanning and transform. Sucrase remains the fallback path.

The transform boundary is `src/source/transform.ts`. Structured transform
diagnostics should use `TransformError` from `src/errors.ts` when line and
column data are available.

## node_modules Materialization

CTS normally resolves npm packages from a flat cache:

```text
<cacheDir>/npm/<name>@<version>/
```

Some tools expect a real filesystem `node_modules`. `cno cache` can materialize
one from the actual scan graph:

```sh
cno cache --npm-mode=soft
cno cache --npm-mode=hard
```

`soft` creates top-level links into the flat cache. `hard` creates per-file
hard links and copies only when linking is not possible.

## Development

From the repository root:

```sh
pnpm run type-check
```

From this directory:

```sh
pnpm run type-check
pnpm run build
```

The root CMake build bundles CTS into the final `cno` binary; this package is
also useful as the loader implementation boundary during development.
