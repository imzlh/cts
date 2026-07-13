# cts/ — Agent Guide

## Overview

`cts/` is the JavaScript runtime layer for `cno-cli`. It resolves imports across npm, JSR, HTTP, file, and node: protocols, caches results in a SQLite lock store, pre-compiles to QuickJS bytecode, and executes via a custom engine hook pipeline.

## Directory Layout

```
cts/
├── main.ts                  # CLI entry — arg parsing, runtime creation, subcommand dispatch
├── AGENT.md                 # This file
│
├── src/                     # All runtime source code
│   ├── types.ts             # Shared types: ModuleFormat, FileKind, ModuleInfo, ConfigOptions, RuntimeConfig
│   ├── config.ts            # parseSize(), createConfig(), loadConfigFile()
│   ├── errors.ts            # ErrorKind enum, err(), formatError(), fatal(), TransformError
│   ├── flow.ts              # ProgressCallback, FetchOptions, StepType, Fs*Step types
│   ├── lock.ts              # LockStore class
│   ├── import-scanner.ts    # ImportScanner — main-thread oxc-first import graph scan
│   ├── scan.ts              # extractImports(), hasImportAttributes(), hasTopLevelEsmSyntax(), path helpers
│   ├── parse.ts             # ParseDriver — transform/precompile worker pool only
│   ├── pack/                # .jspack format, writer, validated extraction/reader
│   ├── precompile.ts        # Thin re-export of parse.ts (ParseDriver / isParseWorker only)
│   ├── shell.ts             # parseShellCommand(), isShellOperator(), resolveWinBinEntry(), resolveUnixBinEntry()
│   ├── task.ts              # TaskRunner, BinResolver, loadTasks()
│   ├── oxc.ts               # OxcTranspiler, tryLoadOxc(), oxcExtPath()
│   ├── deps.ts              # DepScanner class, ScanResult interface
│   │
│   ├── api/                 # Public API barrel re-exports
│   │   └── index.ts         # export { createRuntime, TypeScriptRuntime } from '../runtime/index'
│   │
│   ├── compile/             # Source → QuickJS Module
│   │   ├── index.ts         # ModuleCompiler class
│   │   ├── bridge.ts        # bridgeCjsToEsm(), loadEsmSync(), installGlobalRequire(), buildCjsDeps()
│   │   ├── cjs.ts           # CjsLoader, CjsModule, CjsRequireFn, CjsDeps, buildPaths()
│   │   ├── esm.ts           # EsmCompiler class
│   │   └── wasm.ts          # CompileError, LinkError, RuntimeError, WasmImportSource, buildWasmModule()
│   │
│   ├── resolve/             # Specifier → local path
│   │   ├── index.ts         # ModuleResolver class
│   │   ├── builtins.ts      # BUILTINS set, isBuiltinSpecifier()
│   │   ├── linker.ts        # Hard-link materialization of node_modules tree
│   │   ├── pkg.ts           # readPkg(), readPkgFresh(), clearPkgCache(), normalizeBinField(), getBinMap()
│   │   ├── flow.ts          # I/O step types and runner (Step/StepResult protocol)
│   │   ├── lock.ts          # LockStore (SQLite-backed, module/source/bin tables)
│   │   ├── deps.ts          # DepScanner — concurrent BFS dependency discovery
│   │   └── protocols/       # Protocol handlers
│   │       ├── base.ts      # ProtocolHandler interface, guessFileKind()
│   │       ├── blob.ts      # blob: handler
│   │       ├── data.ts      # data: handler
│   │       ├── file.ts      # file:// handler
│   │       ├── http.ts      # http/https handler
│   │       ├── jsr.ts       # JSR registry handler
│   │       ├── npm.ts       # npm registry handler (largest)
│   │       ├── node.ts      # node: builtin handler
│   │       └── pack.ts      # pack:/ctsview: manifest-only handler
│   │
│   ├── runtime/             # Composition root
│   │   ├── index.ts         # TypeScriptRuntime class, createRuntime()
│   │   ├── hooks.ts         # EngineHookCallbacks, EngineHooks, installEngineHooks()
│   │   ├── lifecycle.ts     # LifecyclePlan, LifecycleCommand, planLifecycleScript()
│   │   ├── meta.ts          # fillMeta() — import.meta population
│   │   ├── resources.ts     # ResourceManager, Cleanup, createResourceManager()
│   │   ├── config.ts        # createConfig(), loadConfigFile(), CLI_TPL
│   │   ├── errors.ts        # ErrorKind, err(), formatError(), fatal()
│   │   └── task/            # Task execution
│   │       ├── index.ts     # TaskRunner
│   │       └── shell.ts     # parseShellCommand, bin-wrapper resolver
│   │
│   ├── source/              # Source loading + transformation
│   │   ├── index.ts         # readSource(), readSourceForCjs()
│   │   ├── transform.ts     # Transformer class, TransformerOptions
│   │   ├── cache.ts         # JscCache class, isRemote()
│   │   ├── oxc.ts           # OxcTranspiler class, OxcModule, tryLoadOxc()
│   │   └── scan.ts          # extractImports(), isTsLikePath(), isScannablePath(), isWasmPath()
│   │
│   ├── debug/               # Debugger integration
│   │
│   └── utils/               # Utilities
│       ├── index.ts         # Barrel re-export (platform, path, io, misc, bin, log, lru, tier, progress)
│       ├── platform.ts      # uname, isWindows
│       ├── path.ts          # toPosixPath(), canonicalizePath(), cwd(), pathRoot(), hasLeadingSlashDrive()
│       ├── io.ts            # readText, readBytes, writeText, ensureDir, resolveFile
│       ├── misc.ts          # errMsg(), assert(), hashString(), cacheFilename(), fmtBytes, isEnabled, log
│       ├── bin.ts           # findLocalBin(), WIN_BIN_EXTS
│       ├── log.ts           # Structured debug logger (DEBUG=category)
│       ├── lru.ts           # LRU<K,V> cache
│       ├── tier.ts          # getMemoryTier() → 'low'|'normal'|'high'
│       ├── progress.ts      # PrecacheProgress class
│       ├── url.ts           # URL polyfill
│       └── curl.ts          # setCurlInitHook(), getCurlInitHook()
│
└── deps/                    # Vendored dependencies
    └── sucrase/             # Sucrase transpiler (fallback when OXC native unavailable)
```

## Architecture

```
  TypeScriptRuntime
  ├── ModuleResolver ────── Protocol Handlers (npm, jsr, http, file, node, data, blob)
  │     ├── LockStore (SQLite) — 3-level cache: L1 specPath index, L2 modules, L3 protocol dispatch
  │     ├── DepScanner — concurrent BFS for dependency discovery
  │     └── PackHandler — offline manifest edge lookup
  ├── ModuleCompiler
  │   ├── EsmCompiler ─── Transformer (oxc native → sucrase fallback) → JscCache
  │   ├── CjsLoader ───── bridgeCjsToEsm / installGlobalRequire
  │   └── WasmCompiler
  ├── ImportScanner ─────── Main-thread import scan (oxc → Sucrase); never on transform workers
  ├── ParseDriver ───────── Transform/precompile worker pool only
  ├── ResourceManager ───── Cleanup for caches/connections
  └── Engine Hooks ──────── resolve/load/init callbacks on QuickJS
```

### Key Flows

**`cno cache <entry>`**: DepScanner parallel BFS → resolve each import → ImportScanner (main) → ParseDriver workers transform to bytecode → persist .jsc → flush lock. Optionally run lifecycle scripts and materialize node_modules.

**`cno run <entry>`**: Create resolver + compiler → install engine.onModule hooks → QuickJS calls resolve/load/init per import → source transformed and compiled on demand (no DepScanner unless `--precache`).

**`cno pack <entry>`**: DepScanner `fullGraph` + ImportScanner → classify relocatable identities → compile under `pack:` ids → validate manifest/ranges → stream an atomic `.jspack`. Running it validates and extracts bundled bytes, registers `PackHandler`, then resolves only through recorded edges.

## Layer Responsibilities

### Top-Level (cts/src/*.ts)
Cross-cutting concerns shared by all layers. No dependencies on compile/resolve/runtime internals.

| File | Key Exports | Responsibility |
|---|---|---|
| `types.ts` | `ModuleFormat`, `FileKind`, `LifecycleScriptName`, `NodeModulesMode`, `ModuleInfo` | Shared type definitions |
| `config.ts` | `parseSize()`, `createConfig()`, `loadConfigFile()` | CLI flags, env vars, config file loading (tsconfig/deno.json/package.json), cache dir |
| `errors.ts` | `ErrorKind` enum, `err()`, `formatError()`, `fatal()`, `TransformError` | Error creation, formatting, colourised output |
| `flow.ts` | `ProgressCallback`, `FetchOptions`, `StepType`, `FsExistsStep`, `FsReadTextStep` | Generator-based async I/O — Step/StepResult protocol |
| `lock.ts` | `LockStore` | SQLite-backed persistent cache (modules, sources, bins tables) |
| `import-scanner.ts` | `ImportScanner` | Main-thread oxc-first import graph scan (pack + precache) |
| `scan.ts` | `extractImports()`, `hasImportAttributes()`, `hasTopLevelEsmSyntax()`, path helpers | Sucrase extractImports fallback + cheap linear detectors |
| `parse.ts` | `ParseDriver`, `isParseWorker()`, `runParseWorker()` | Transform/precompile worker pool only (no scan tasks) |
| `shell.ts` | `parseShellCommand()`, `isShellOperator()`, `resolveWinBinEntry()`, `resolveUnixBinEntry()` | Shell command parsing, npm bin-wrapper resolution |
| `task.ts` | `TaskRunner`, `BinResolver`, `loadTasks()` | Deno task runner, binary resolution |
| `oxc.ts` | `OxcTranspiler`, `OxcModule`, `tryLoadOxc()`, `oxcExtPath()` | OXC native extension wrapper |
| `deps.ts` | `DepScanner`, `ScanResult` | Concurrent BFS dependency discovery |
| `pack/` | `writePack()`, `PackSession`/`PackBlobStore`, `loadPack()` | Container build + 1× map, lazy 0-copy load |
| `utils/memfs.ts` | `VirtualFileStore`, `MemoryFileStore`, `getMemoryBytecode` | Active overlay; pack bytecode views for on-demand deserialize |

### resolve/ — Specifier → Local Path
Pure resolution logic. Given a specifier + referrer, produces a local file path or downloads the module.

| File | Key Exports | Responsibility |
|---|---|---|
| `index.ts` | `ModuleResolver` | 3-level cache + protocol dispatch orchestrator |
| `builtins.ts` | `BUILTINS`, `isBuiltinSpecifier()` | Node.js builtin module detection |
| `linker.ts` | (none — internal) | Hard-link materialization of node_modules tree |
| `pkg.ts` | `readPkg()`, `readPkgFresh()`, `clearPkgCache()`, `normalizeBinField()`, `getBinMap()` | package.json utilities |
| `flow.ts` | Step types, `runSync()`, `runAsync()` | Generator-based I/O driver |
| `lock.ts` | `LockStore` | SQLite lock store (same class, different import path) |
| `deps.ts` | `DepScanner` | Concurrent BFS dependency scanner |
| `protocols/base.ts` | `ProtocolHandler` interface, `guessFileKind()` | Handler contract + file kind inference |
| `protocols/blob.ts` | — | `blob:` URL handler |
| `protocols/data.ts` | — | `data:` URL handler |
| `protocols/file.ts` | — | `file://` handler |
| `protocols/http.ts` | — | `http/https` handler (libcurl) |
| `protocols/jsr.ts` | — | JSR registry handler |
| `protocols/npm.ts` | — | npm registry handler (largest, handles tarballs + lifecycle) |
| `protocols/node.ts` | — | `node:` builtin module handler |
| `protocols/pack.ts` | `PackHandler` | Offline `pack:` and `ctsview:` lookup from a validated manifest |

### compile/ — Source → QuickJS Module
Takes a resolved file path + source, produces a loaded QuickJS Module.

| File | Key Exports | Responsibility |
|---|---|---|
| `index.ts` | `ModuleCompiler` | Facade — detects ESM/CJS/WASM, delegates |
| `bridge.ts` | `bridgeCjsToEsm()`, `loadEsmSync()`, `installGlobalRequire()`, `buildCjsDeps()` | CJS ↔ ESM interop |
| `cjs.ts` | `CjsLoader`, `CjsModule`, `CjsRequireFn`, `CjsDeps`, `buildPaths()` | CJS compilation engine |
| `esm.ts` | `EsmCompiler` | ESM compilation + circular dep detection |
| `wasm.ts` | `CompileError`, `LinkError`, `RuntimeError`, `buildWasmModule()` | WASM compilation with circular dep support |

### runtime/ — Composition Root
Wires resolver + compiler + hooks together. Owns the engine instance.

| File | Key Exports | Responsibility |
|---|---|---|
| `index.ts` | `TypeScriptRuntime`, `createRuntime()` | Top-level object graph + lifecycle |
| `hooks.ts` | `EngineHookCallbacks`, `EngineHooks`, `installEngineHooks()` | engine.onModule resolve/load/init |
| `lifecycle.ts` | `LifecyclePlan`, `LifecycleCommand`, `planLifecycleScript()` | npm lifecycle script planning |
| `meta.ts` | `fillMeta()` | import.meta population (url, filename, resolve) |
| `resources.ts` | `ResourceManager`, `createResourceManager()` | Resource cleanup (caches, connections) |
| `task/` | `TaskRunner`, `parseShellCommand()` | Deno task execution + shell parsing |

### source/ — Source Loading + Transformation
Format-agnostic layer between resolve and compile. Reads files, transforms to JS.

| File | Key Exports | Responsibility |
|---|---|---|
| `index.ts` | `readSource()`, `readSourceForCjs()` | Read + transform source files |
| `transform.ts` | `Transformer`, `TransformerOptions` | oxc (native) → sucrase (fallback) |
| `cache.ts` | `JscCache`, `isRemote()` | L1 memory + L2 disk bytecode cache |
| `oxc.ts` | `OxcTranspiler`, `tryLoadOxc()` | OXC native extension wrapper |
| `scan.ts` | `extractImports()`, `isTsLikePath()` | Import specifier extraction |

### utils/ — Utilities
No circular deps. Used everywhere.

| File | Key Exports | Responsibility |
|---|---|---|
| `index.ts` | barrel re-export | platform, path, io, misc, bin, log, lru, tier, progress |
| `platform.ts` | `uname`, `isWindows` | OS detection |
| `path.ts` | `toPosixPath()`, `canonicalizePath()`, `cwd()`, `pathRoot()` | Path normalisation (backslash → `/`) |
| `io.ts` | `readText`, `readBytes`, `writeText`, `ensureDir()`, `resolveFile()` | File I/O with bounded LRU cache |
| `misc.ts` | `errMsg()`, `assert()`, `hashString()`, `cacheFilename()`, `fmtBytes`, `isEnabled`, `log` | Hash, semver, tar.gz, JSONC, arg parsing |
| `bin.ts` | `findLocalBin()`, `WIN_BIN_EXTS` | node_modules/.bin resolution |
| `log.ts` | `isEnabled()`, `log` | Structured debug logger (DEBUG=category) |
| `lru.ts` | `LRU<K,V>` | Bounded LRU cache (Map-based, O(1)) |
| `tier.ts` | `getMemoryTier()` → `'low'|'normal'|'high'` | OS memory tier detection |
| `progress.ts` | `PrecacheProgress` | Terminal progress spinners |
| `url.ts` | `URL` | URL polyfill |
| `curl.ts` | `setCurlInitHook()`, `getCurlInitHook()` | libcurl init hook |

## Conventions

- **Errors**: always use `err(ErrorKind, msg)` — sets `.kind` for actionable `formatError()` output
- **Logging**: `log.debug(category, () => msg)` (lazy, zero cost when disabled); `log.warn(category, msg)`, `log.info(msg)`
- **Paths**: `toPosixPath()` before string comparison; Windows backslashes normalized at entry
- **Flow**: protocol handlers `yield Step`; `runSync`/`runAsync` drive them — no direct I/O inside handlers
- **LRU**: instantiate with capacity, use `get`/`set` — no manual eviction
- **Module identity**: use `moduleRef(info)` (returns `info.moduleId ?? info.specPath`) as the QuickJS module name, not `localPath`
- **Pack isolation**: do not resolve a missing manifest edge against disk/network; incomplete scans and compiles are fatal
- **Attribute views**: use `moduleViewRef()`; do not encode view state in a user query/hash suffix
- **Bytecode safety**: propagate `cacheBytecode: false` for `sourceOnly` pack entries so warm caches cannot erase import attributes
- **Pack writes**: validate first, stream to a same-directory temporary file, `fsync`, and atomically rename
- **Pack extract integrity**: reuse only byte-identical files; heal with temp + `fsync` + rename (`.complete`/size alone is not integrity)
- **Lock ownership**: pack may fill dependency caches but never persists `cts.lock` or runs lifecycle scripts
- **Workers**: ParseDriver grows lazily; always `terminate()` when done
- **Header comments**: removed — responsibilities documented here, not in-file

## Pack Verification

After changes under `pack/`, `deps.ts`, module identity, resolution, or bytecode
caching, rebuild the embedded CLI and run at least:

```bash
cmake --build build -j2
CTS_CACHE_DIR=/tmp/cno-pack-test build/stage/cno setup
CTS_CACHE_DIR=/tmp/cno-pack-test build/stage/cno test tests/cts/pack-command.test.ts --concurrency=1
CTS_CACHE_DIR=/tmp/cno-pack-test build/stage/cno test tests/cts/import-attributes-runtime.test.ts tests/cjs/require-esm-interop.test.ts --concurrency=1
git diff --check
git -C cts diff --check
```

The pack suite must exercise the same artifact more than once: the second run
is what detects unsafe `sourceOnly` bytecode reuse and same-length extract-cache
tampering on text/bytes/CJS attribute paths.

## External Dependencies

- **QuickJS engine** (`engine`) — JSContext, Module, source maps, worker, process
- **SQLite3** (`sqlite3`) — lock store
- **libcurl** (`curl`) — HTTP with connection pooling
- **OXC native** (`ext-oxc/native`) — optional fast transpiler, loaded at runtime
- **Sucrase** (`deps/sucrase/`) — vendored, fallback transpiler/parser
