# cts2

TypeScript runner for [circu.js](https://github.com/nicholasgasior/circu.js) (QuickJS-based runtime). Run `.ts` files directly, import from npm/jsr/http, use Node.js polyfills.

## Usage

```sh
cts <file.ts> [args...]       # run a TypeScript file
cts cache <file.ts>           # pre-download all deps + write lock
cts task                      # list deno.json tasks
cts task <name> [args...]     # run a deno.json task
cts --help
cts --version
```

## Supported import protocols

| Specifier | Example |
|-----------|---------|
| relative / absolute | `./foo.ts`, `/abs/path.ts` |
| `file://` | `file:///home/user/mod.ts` |
| `npm:` | `npm:chalk@5`, `npm:lodash/fp` |
| `jsr:` | `jsr:@std/http`, `jsr:@std/http@^1.0` |
| `http/https:` | `https://deno.land/x/oak/mod.ts` |
| `node:` | `node:fs`, `node:path` (requires polyfill) |
| `data:` | `data:text/javascript,export default 42` |

Import map, path aliases, and `baseUrl` are read automatically from `tsconfig.json` and `deno.json`.

## Import attributes

```ts
import bytes from './font.woff'  with { type: 'bytes' };
import text  from './template'   with { type: 'text' };
import mod   from './legacy.cjs' with { type: 'commonjs' };
```

## Options

```
--cache-dir <path>     Cache directory (default: ~/.cts)
--polyfill <file>      Load a polyfill before the entry file
--precache             Pre-download all deps then run
--no-lock              Disable lock file
--frozen               Fail if any import is missing from lock (CI)
--lock-dir <path>      Directory for cts.lock (default: entry dir)
--no-http              Disable http/https imports
--no-jsr               Disable jsr: imports
--no-node              Disable Node.js compatibility
--silent               Suppress download progress
--disable-cache        Skip JSC bytecode cache
--memory-limit <size>  e.g. 256MB, 1GB
--max-stack-size <n>   e.g. 4MB
--jsr-cache-ttl <days> JSR metadata TTL (default: 7)
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CTS_CACHE_DIR` | `~/.cts` | Cache directory |
| `CTS_SILENT` | `false` | Suppress output |
| `CTS_ENABLE_HTTP` | `true` | Allow http/https imports |
| `CTS_ENABLE_JSR` | `true` | Allow jsr: imports |
| `CTS_ENABLE_NODE` | `true` | Allow node: imports |
| `CTS_DISABLE_CACHE` | `false` | Skip bytecode cache |
| `CTS_DEBUG` | — | Debug categories |

## Debug logging

```sh
CTS_DEBUG=*                # all categories
CTS_DEBUG=resolver,npm     # specific categories
CTS_DEBUG=resolver,!lock   # exclude a category
```

Categories: `resolver`, `npm`, `jsr`, `lock`, `cjs`, `loader`, `config`, `stack`

## Lock file

`cts.lock` is written next to the entry file. It caches all module resolutions so subsequent runs skip network calls entirely. Safe to commit to version control.

```sh
cts cache src/main.ts     # full dep scan, download everything, write clean lock
cts --frozen src/main.ts  # fail if any import is not in the lock (good for CI)
```

## deno.json tasks

```json
{
  "tasks": {
    "dev": "deno run --watch src/main.ts",
    "build": {
      "command": "deno run build.ts",
      "dependencies": ["clean"],
      "env": { "NODE_ENV": "production" }
    },
    "clean": "rm -rf dist"
  }
}
```

`deno run [flags] <file>` is transparently rewritten to a `cts` invocation. Deno permission flags (`--allow-*`, `--unstable-*`) are stripped.

## ESM / CJS interop

- **ESM imports CJS**: `default` = whole `module.exports`; named keys also re-exported
- **ESM imports transpiled CJS** (`__esModule: true`): `default` = `exports.default`, named exports preserved
- **CJS `require()` of ESM**: synchronous extraction; returns `exports.default` if present, namespace otherwise

## Cache layout

```
~/.cts/
  version          engine version marker (clears .jsc files on upgrade)
  jsr/             JSR packages
  npm/             npm packages (name@version/)
  http/            http/https modules (by host/hash)
  data/            data: URL blobs
  node/            Node.js polyfills
```

`.jsc` bytecode caches live alongside source files and are reused on repeat runs.
