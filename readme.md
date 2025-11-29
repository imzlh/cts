# TypeScript Runtime for tjs

A complete, modular TypeScript/TSX/JSX runtime for QuickJS/tjs with HTTP imports, JSR packages (with version ranges), Node.js compatibility, and automatic NPM package installation.

## 🎯 Features

- ✨ **TypeScript/TSX/JSX** - Seamless support using Sucrase
- 🌐 **HTTP(S) Imports** - Load modules directly from URLs
- 📦 **JSR Support** - Import packages with version ranges (`^1.0.0`, `~1.2.3`)
- 🔄 **Smart Caching** - download on need, smart and powerful
- 🚀 **Auto NPM Install** - Automatically downloads missing NPM packages
- 🔧 **Node.js Compatibility** - Support for `node:` protocol imports
- 📚 **NPM Packages** - Local or global `node_modules` with auto-download
- 🗺️ **Path Aliases** - `tsconfig.json` and `deno.json` path mappings
- ⚡ **ES2025 Syntax** - Latest JavaScript features
- 🔌 **Extensible** - Modular architecture for easy extension

## 📦 Installation

```bash
# Copy all files to your project
typescript-runtime/
├── cli.ts
├── config.ts
├── index.ts
├── resolver.ts
├── runtime.ts
├── transformer.ts
├── types.ts
├── utils.ts
├── version.ts       # Version comparison
├── targz.ts         # Tar.gz extraction
└── resolvers/
    ├── http.ts
    ├── jsr.ts      # JSR with version ranges
    ├── node.ts
    └── npm.ts      # NPM with auto-download
```

## 🚀 Quick Start

### Basic TypeScript

```typescript
// main.ts
interface User {
  name: string;
  age: number;
}

const user: User = {
  name: 'Alice',
  age: 30
};

console.log(`Hello, ${user.name}!`);
```

```bash
tjs cli.ts main.ts
```

### JSR Packages with Version Ranges

```typescript
// test.ts
import { assert } from "jsr:@std/assert@^1.0.16";  // ✅ Supports version ranges
import { parse } from "jsr:@std/path@~0.200.0";     // ✅ Latest matching version

// ✅ Relative imports within JSR modules work correctly
// mod.ts internally imports ./almost_equals.ts - this now works!

assert(1 + 1 === 2);
const parsed = parse('/path/to/file.ts');
console.log('✓ Tests passed!');
```

```bash
tjs cli.ts test.ts
# 📦 Fetching metadata for @std/assert@1.0.17
# 📦 Downloading @std/assert@1.0.17/mod.ts
# 📦 Downloading @std/assert@1.0.17/almost_equals.ts  # ✅ Relative import resolved
# ✓ Tests passed!
```

### NPM Packages (Auto-Install)

```typescript
// app.ts
import _ from 'lodash';

const arr = [1, 2, 2, 3, 3, 3];
const unique = _.uniq(arr);
console.log(unique); // [1, 2, 3]
```

```bash
tjs cli.ts app.ts
# 📦 Auto-installing lodash to global cache...
#   Downloading lodash@4.17.21...
#   Extracting...
# ✓ lodash@4.17.21 installed to ~/.tjs/cache/node_modules/lodash
# [1, 2, 3]
```

## 📖 Version Range Support

### Supported Formats

```typescript
// Caret (^) - Compatible with version
import { assert } from "jsr:@std/assert@^1.0.0";    // >=1.0.0 <2.0.0
import { assert } from "jsr:@std/assert@^1.2.3";    // >=1.2.3 <2.0.0
import { assert } from "jsr:@std/assert@^0.1.0";    // >=0.1.0 <0.2.0

// Tilde (~) - Reasonably close
import { parse } from "jsr:@std/path@~1.2.3";       // >=1.2.3 <1.3.0

// Comparison operators
import { serve } from "jsr:@std/http@>=0.200.0";    // >=0.200.0
import { serve } from "jsr:@std/http@<2.0.0";       // <2.0.0

// Range
import { fs } from "jsr:@std/fs@1.0.0 - 2.0.0";     // >=1.0.0 <=2.0.0

// Wildcards
import { util } from "jsr:@std/util@1.x";           // 1.0.0, 1.1.0, 1.2.0, ...
import { util } from "jsr:@std/util@1.*";           // Same as above

// Exact version
import { assert } from "jsr:@std/assert@1.0.16";    // Exactly 1.0.16

// No version (latest)
import { assert } from "jsr:@std/assert";           // Latest version
```

### Version Matching Logic

```typescript
import { matchLatestVersion } from './version.ts';

const versions = ['1.0.0', '1.0.16', '1.0.17', '1.1.0', '2.0.0'];

matchLatestVersion(versions, '^1.0.16');  // Returns: '1.0.17'
matchLatestVersion(versions, '~1.0.16');  // Returns: '1.0.17'
matchLatestVersion(versions, '^1.0.0');   // Returns: '1.1.0'
matchLatestVersion(versions, '>=1.0.16'); // Returns: '2.0.0'
```

## 🔧 NPM Auto-Install

### How It Works

1. **Local Search**: Searches for package in local `node_modules`
2. **Auto-Download**: If not found, automatically downloads from NPM registry
3. **Global Cache**: Installs to `~/.tjs/cache/node_modules/`
4. **Tar.gz Extract**: Automatically extracts downloaded packages

### NPM Registry Configuration

```bash
# Method 1: Environment Variable
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

# Method 2: ~/.npmrc file
echo "registry=https://registry.npmmirror.com" >> ~/.npmrc

# Method 3: Default
# Uses https://registry.npmjs.org by default
```

### Auto-Install Example

```typescript
// No need to run npm install!
import express from 'express';
import _ from 'lodash';
import chalk from 'chalk';

// Packages are automatically downloaded on first use
console.log(chalk.green('Hello World!'));
```

```bash
tjs cli.ts app.ts
# 📦 Auto-installing express to global cache...
#   Downloading express@4.18.2...
#   Extracting...
# ✓ express@4.18.2 installed
# 📦 Auto-installing lodash to global cache...
#   Downloading lodash@4.17.21...
#   Extracting...
# ✓ lodash@4.17.21 installed
# ...
```

## 📁 Cache Structure

### JSR Cache (On-Demand)

```
~/.tjs/cache/jsr/
└── std/
    └── assert/
        ├── meta.json                    # Package metadata (all versions)
        ├── 1.0.16/
        │   ├── meta.json               # Version metadata
        │   └── mod.ts                  # Downloaded on-demand
        └── 1.0.17/
            ├── meta.json
            └── mod.ts                  # Only downloaded when needed
```

**Benefits**:
- ✅ Only downloads needed files
- ✅ Supports version ranges
- ✅ Caches metadata with TTL

### NPM Cache (Auto-Install)

```
~/.tjs/cache/node_modules/
├── lodash/
│   ├── package.json
│   ├── lodash.js
│   └── ...
└── @types/
    └── node/
        ├── package.json
        └── index.d.ts
```

### HTTP Cache

```
~/.tjs/cache/http/
└── deno.land/
    ├── abc123.ts
    └── def456.js
```

## ⚙️ Configuration

### Command Line Options

```bash
tjs cli.ts [options] <file.ts> [args...]

Options:
  --help, -h              Show help message
  --version, -v           Show version
  --cache-dir <path>      Cache directory (default: ~/.tjs/cache)
  --no-http               Disable HTTP imports
  --no-jsr                Disable JSR imports
  --no-node               Disable Node.js compat
  --silent                Suppress logs
  --memory-limit <size>   Memory limit (e.g., 512MB, 1GB)
  --max-stack-size <size> Stack size (e.g., 2MB)
  --jsr-cache-ttl <days>  JSR cache TTL in days (default: 7)
```

### Environment Variables

```bash
# Cache directory
export CTS_CACHE_DIR=/custom/cache/path

# NPM registry (for auto-install)
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

# Feature toggles
export CTS_ENABLE_HTTP=true
export CTS_ENABLE_JSR=true
export CTS_ENABLE_NODE=true

# Silent mode
export CTS_SILENT=false

# Resource limits
export CTS_MEMORY_LIMIT=512MB
export CTS_MAX_STACK_SIZE=2MB

# JSR cache TTL (days)
export CTS_JSR_CACHE_TTL=7
```

### Configuration Files

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@utils/*": ["src/utils/*"]
    }
  }
}
```

**deno.json:**
```json
{
  "imports": {
    "@/": "./src/",
    "std/": "https://deno.land/std@0.200.0/"
  },
  "compilerOptions": {
    "paths": {
      "@utils/*": ["./src/utils/*"]
    }
  }
}
```

## 🎨 Import Examples

```typescript
// Local modules
import { foo } from './utils.ts';
import { bar } from '../lib/helpers.js';

// NPM packages (auto-installed)
import lodash from 'lodash';
import chalk from 'chalk';

// HTTP imports
import { serve } from 'https://deno.land/std@0.200.0/http/server.ts';

// JSR imports with version ranges
import { assert } from 'jsr:@std/assert@^1.0.16';
import { parse } from 'jsr:@std/path@~0.200.0';

// Node.js builtins
import fs from 'node:fs';
import path from 'node:path';

// Path aliases
import { helper } from '@/utils/helper.ts';
import { config } from '@utils/config.ts';
```

## 🛠️ Programmatic Usage

```typescript
import { createRuntime } from './runtime.ts';

const runtime = createRuntime({
  cacheDir: '/tmp/cache',
  enableHttp: true,
  enableJsr: true,
  enableNode: true,
  silent: false,
  jsrCacheTTL: 7 * 24 * 60 * 60 * 1000,  // 7 days
});

// Register custom Node.js resolver
runtime.registerNodeResolver((name) => {
  const builtins = {
    'fs': '/path/to/node/fs.js',
    'path': '/path/to/node/path.js',
  };
  return builtins[name] || null;
});

// Import and run
await import('./main.ts');
```

## 🔍 Troubleshooting

### Clear Cache

```bash
# Clear all caches
rm -rf ~/.tjs/cache

# Clear JSR cache only
rm -rf ~/.tjs/cache/jsr

# Clear NPM cache only
rm -rf ~/.tjs/cache/node_modules
```

### Debug Mode

```bash
# Enable verbose logging
tjs cli.ts --no-silent app.ts

# Or via environment
export CTS_SILENT=false
tjs cli.ts app.ts
```

### NPM Registry Issues

```bash
# Use mirror registry
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
tjs cli.ts app.ts

# Or configure in ~/.npmrc
echo "registry=https://registry.npmmirror.com" >> ~/.npmrc
```

### Memory Issues

```bash
# Increase memory limit
tjs cli.ts --memory-limit 1GB app.ts

# Or via environment
export CTS_MEMORY_LIMIT=1GB
tjs cli.ts app.ts
```

## 📊 Performance

### JSR On-Demand Downloads

- **Before**: Downloads entire package (~100+ files)
- **After**: Downloads only needed files (~1-5 files)
- **Savings**: 95%+ bandwidth reduction

### NPM Auto-Install

- **Speed**: ~2-5 seconds for most packages
- **Cache**: Subsequent imports are instant
- **Size**: Only downloads what you use

## 🤝 Contributing

Contributions welcome! The modular architecture makes it easy to extend:

1. Add new resolvers in `resolvers/`
2. Extend configuration in `config.ts`
3. Add transformers in `transformer.ts`
4. Update types in `types.ts`

## 📄 License

MIT

## 🙏 Credits

- **Sucrase** - Fast TypeScript/JSX transformation
- **JSR** - JavaScript Registry
- **circu.js** - Javascript runtime with full freedom!
- **zlib** - Compression utilities

---

**Made with ❤️ for the cjs community**