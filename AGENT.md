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
│   ├── import-scanner.ts    # ImportScanner — oxc-first extraction used by parse workers
│   ├── module-hooks.ts      # Process-wide synchronous node:module hook chain
│   ├── scan.ts              # extractImports(), hasImportAttributes(), path helpers
│   ├── parse.ts             # ParseDriver — worker scan/transform, main-thread compile
│   ├── pack/                # .jspack format, writer, validated extraction/reader
│   ├── precompile.ts        # Thin re-export of parse.ts (ParseDriver / isParseWorker only)
│   ├── shell.ts             # parseShellCommand(), isShellOperator(), resolveWinBinEntry(), resolveUnixBinEntry()
│   ├── task.ts              # TaskRunner, BinResolver, loadTasks()
│   ├── task-shell.ts        # shell/bin-wrapper resolution for the task runner
│   ├── wasm-imports.ts      # WASM import-module extraction (pack graph edges)
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
│   │   ├── linker.ts        # Project node_modules materialize (store read-only)
│   │   ├── pkg.ts           # readPkg(), readPkgFresh(), clearPkgCache(), normalizeBinField(), getBinMap()
│   │   └── protocols/       # Protocol handlers
│   │   # NOTE: no resolve/flow.ts, resolve/lock.ts or resolve/deps.ts — those three
│   │   # live at the TOP level (cts/src/flow.ts, cts/src/lock.ts, cts/src/deps.ts).
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
│   │   ├── event-mux.ts     # engine event multiplexing
│   │   └── resources.ts     # ResourceManager, Cleanup, createResourceManager()
│   │   # NOTE: config.ts and errors.ts live at the TOP level (cts/src/), not here,
│   │   # and there is no runtime/task/ — the task runner is cts/src/task.ts plus
│   │   # cts/src/task-shell.ts.
│   │
│   ├── source/              # Source loading + transformation
│   │   ├── index.ts         # readSource(), readSourceForCjs()
│   │   ├── transform.ts     # Transformer class, TransformerOptions
│   │   └── cache.ts         # JscCache class, isRemote()
│   │   # NOTE: no source/oxc.ts or source/scan.ts — those live at the top level
│   │   # (cts/src/oxc.ts, cts/src/scan.ts). source/ holds exactly these three.
│   │
│   ├── debug/               # Debugger integration
│   │
│   └── utils/               # Utilities
│       ├── index.ts         # Barrel re-export (platform, path, io, misc, bin, log, lru, tier, progress)
│       ├── platform.ts      # uname, isWindows
│       ├── path.ts          # POSIX path normalization, host-boundary conversion, file URLs, roots, relativePath(), isPathWithin()
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
  ├── ImportScanner ─────── OXC/Sucrase import extraction used inside parse workers
  ├── ParseDriver ───────── Worker scan/transform; main-thread QuickJS bytecode compile
  ├── ResourceManager ───── Cleanup for caches/connections
  └── Engine Hooks ──────── resolve/load/init callbacks on QuickJS
```

### Key Flows

**`cno cache <entry>`**: DepScanner parallel BFS → resolve each import → ParseDriver workers scan/transform → main thread compiles bytecode → persist .jsc → flush lock. Optionally run lifecycle scripts and materialize node_modules.

**`cno run <entry>`**: Create resolver + compiler → install engine.onModule hooks → QuickJS calls resolve/load/init per import → source transformed and compiled on demand (no DepScanner unless `--precache`).

**`cno pack <entry>`**: DepScanner `fullGraph` + worker import scan (JS/TS + WASM import modules) → classify relocatable identities → build offline `edges` from scan `resolutions` only → transform on workers and compile under `pack:` ids on main → validate manifest/ranges → stream an atomic `.jspack`. Running it maps the container, registers `PackHandler`, then resolves only through recorded edges.

## Layer Responsibilities

### Top-Level (cts/src/*.ts)
Cross-cutting concerns shared by all layers. No dependencies on compile/resolve/runtime internals.

| File | Key Exports | Responsibility |
|---|---|---|
| `types.ts` | `ModuleFormat`, `FileKind`, `LifecycleScriptName`, `NodeModulesMode`, `ModuleInfo` | Shared type definitions |
| `config.ts` | `parseSize()`, `createConfig()`, `loadConfigFile()` | CLI flags, env vars, config file loading (tsconfig/deno.json/package.json), cache dir |
| `errors.ts` | `ErrorKind` enum, `err()`, `formatError()`, `fatal()`, `TransformError` | Error creation, formatting, colourised output |
| `flow.ts` | `ProgressCallback`, `FetchOptions`, `StepType`, `FsExistsStep`, `FsReadTextStep` | Generator-based async I/O — Step/StepResult protocol |
| `lock.ts` | `LockStore` | SQLite-backed persistent cache (modules, sources, imports, bins tables) |
| `module-hooks.ts` | `registerModuleHooks()`, `runModuleResolveHooks()` | Shared synchronous `node:module` hook registry used by CTS and the Node bridge |
| `import-scanner.ts` | `ImportScanner` | OXC-first import extraction shared by workers and explicit inline mode |
| `scan.ts` | `extractImports()`, `hasImportAttributes()`, path helpers | Sucrase extractImports fallback + cheap attribute detector |
| `parse.ts` | `ParseDriver`, `isParseWorker()`, `runParseWorker()` | Worker import scan/transform; main-thread bytecode compile |
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
| `linker.ts` | `materializeNodeModules`, `buildInstallViewEdges` | soft roots / hard virtual store (`.cts`); store never written |
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

`source/` contains **only** those three files. Earlier revisions of this table also
listed `source/oxc.ts` and `source/scan.ts`; **neither exists.** The real modules are
top-level: `cts/src/oxc.ts` (`OxcTranspiler`, `OxcModule`, `isOxcModule()`,
`oxcExtPath()`, `tryLoadOxc()`) and `cts/src/scan.ts` (`extractImports()`,
`hasImportAttributes()`, `isTsLikePath()`, `isScannablePath()`, `isWasmPath()`) —
both already listed in the top-level table above. `import-scanner.ts` imports them
as `./oxc` and `./scan`, not `./source/…`.

### utils/ — Utilities
No circular deps. Used everywhere.

| File | Key Exports | Responsibility |
|---|---|---|
| `index.ts` | barrel re-export | platform, path, io, misc, bin, log, lru, tier, progress |
| `platform.ts` | `uname`, `isWindows` | OS detection |
| `path.ts` | `toPosixPath()`, `canonicalizePath()`, `cwd()`, `pathRoot()`, `relativePath()`, `isPathWithin()` | POSIX-internal path normalization, file URL conversion, host-boundary conversion and root/containment rules |
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
- **Bytecode identity**: pass the effective QuickJS module identity through every `JscCache` load/freshness/write API; identity-aware sidecars reject legacy or mismatched stamps instead of reusing a bytecode graph compiled for another ref. Capture `SourceFreshness` before reading a file and pass it to persistence, so edits during compilation cannot bless stale bytecode. If that snapshot fails, execute without persisting. Remote bytecode is adjacent only when the resolved file is inside the configured cache root; workspace/symlink targets use the hashed local cache. Cache roots are normalized in both `createConfig` and `JscCache`, so trailing/repeated separators cannot change ownership or cache keys; protocol specifiers remain untouched by filesystem normalization.
- **Pack isolation**: do not resolve a missing manifest edge against disk/network; incomplete scans and compiles are fatal
- **Attribute views**: use `moduleViewRef()`; do not encode view state in a user query/hash suffix
- **Bytecode safety**: propagate `cacheBytecode: false` for `sourceOnly` pack entries so warm caches cannot erase import attributes
- **Pack writes**: validate first, stream to a same-directory temporary file, `fsync`, and atomically rename
- **Pack extract integrity**: reuse only byte-identical files; heal with temp + `fsync` + rename (`.complete`/size alone is not integrity)
- **Lock ownership**: pack may fill dependency caches but never persists `cts.lock` or runs lifecycle scripts
- **Lock trust**: resolver lock hits are authoritative; never add path, format, existence, or cache-dir revalidation
- **Import graph cache**: warm precache may reuse `imports`; pack/fullGraph callbacks must scan their current source
- **Workers**: ParseDriver grows lazily for scan/transform; transport failures retry on replacement workers, never degrade to main; always `terminate()` when done
- **Module format**: never infer ESM/CJS from source contents; use extensions, package metadata/conditions, or an explicit caller format
- **CJS failure cleanup**: remove a failed module from both cache and its original parent's `children`; capture the parent before user code can mutate `module.parent`
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
