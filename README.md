# CTS2 - Circu TypeScript Loader v2.0

A modern, robust TypeScript loader for circu.js with enhanced protocol support, unified CommonJS/ESM handling, and dependency pre-caching.

## Features

- **Unified Module System**: Seamless handling of ESM and CommonJS modules
- **Enhanced Protocol Support**:
  - `file://` - Local filesystem
  - `http://` / `https://` - Remote modules with caching
  - `npm:` - NPM packages
  - `jsr:` - JSR (JavaScript Registry) packages
  - `node:` - Node.js built-in modules (with stubs)
  - `data:` - Data URLs (RFC 2397)
- **Smart Caching**: Automatic caching of remote modules with configurable TTL
- **Dependency Pre-caching**: Deno-style dependency pre-caching for faster cold starts
- **TypeScript Support**: Full TypeScript compilation via Sucrase
- **Path Aliases**: Support for tsconfig.json/deno.json path aliases
- **Import Maps**: Support for import map resolution

## Installation

```typescript
import { Loader, createLoader } from "./src/index.ts";
```

## Quick Start

```typescript
import { createLoader } from "./src/index.ts";

// Create a loader instance
const loader = createLoader({
    debug: true,
    config: {
        cacheDir: "/tmp/cts2-cache",
        enableHttp: true,
        enableJsr: true
    }
});

// Import a module
const module = await loader.import("./my-module.ts");

// Import from npm
const lodash = await loader.import("npm:lodash");

// Import from JSR
const oak = await loader.import("jsr:@oak/oak");

// Import from HTTP
const lib = await loader.import("https://example.com/lib.ts");
```

## Configuration

Create a `deno.json` or `tsconfig.json` in your project root:

```json
{
    "imports": {
        "@/": "./src/"
    },
    "compilerOptions": {
        "paths": {
            "@/*": ["./src/*"]
        }
    }
}
```

### Configuration Options

```typescript
interface ConfigOptions {
    /** Cache directory for remote modules */
    cacheDir?: string;
    
    /** Enable HTTP/HTTPS module loading */
    enableHttp?: boolean;
    
    /** Enable JSR module loading */
    enableJsr?: boolean;
    
    /** Enable Node.js compatibility layer */
    enableNode?: boolean;
    
    /** Silent mode - suppress download logs */
    silent?: boolean;
    
    /** JSR cache TTL in milliseconds (default: 1 hour) */
    jsrCacheTTL?: number;
    
    /** NPM cache TTL in milliseconds (default: 1 hour) */
    npmCacheTTL?: number;
    
    /** HTTP cache TTL in milliseconds (default: 1 hour) */
    httpCacheTTL?: number;
    
    /** Path aliases from tsconfig.json/deno.json */
    pathAliases?: Record<string, string[]>;
    
    /** Base URL for path resolution */
    baseUrl?: string;
    
    /** Import map from deno.json */
    importMap?: Record<string, string>;
    
    /** Disable cache for remote modules */
    disableCache?: boolean;
    
    /** Enable dependency pre-caching */
    enablePreCache?: boolean;
    
    /** Maximum redirects for HTTP requests */
    maxRedirects?: number;
    
    /** Request timeout in milliseconds */
    requestTimeout?: number;
    
    /** User agent for HTTP requests */
    userAgent?: string;
    
    /** NPM registry URL */
    npmRegistry?: string;
    
    /** JSR registry URL */
    jsrRegistry?: string;
}
```

## Protocol Support

### File Protocol

```typescript
// Local files (file:// is optional)
await loader.import("./local-module.ts");
await loader.import("file:///absolute/path/module.ts");
```

### HTTP/HTTPS Protocol

```typescript
// Remote modules with automatic caching
await loader.import("https://deno.land/std@0.200.0/http/server.ts");
```

### NPM Protocol

```typescript
// NPM packages
await loader.import("npm:lodash");
await loader.import("npm:lodash@4.17.21");
await loader.import("npm:@types/node");
```

### JSR Protocol

```typescript
// JSR packages
await loader.import("jsr:@oak/oak");
await loader.import("jsr:@std/http@0.200.0");
```

### Node Protocol

```typescript
// Node.js built-ins (with stubs)
import { path } from "node:path";
import { os } from "node:os";
import { util } from "node:util";
```

### Data Protocol

```typescript
// Data URLs
await loader.import("data:text/javascript,export default 42;");
await loader.import("data:application/json;base64,eyJrZXkiOiJ2YWx1ZSJ9");
```

## Dependency Pre-caching

```typescript
const loader = createLoader({
    config: { enablePreCache: true }
});

// Pre-cache dependencies
await loader.preCache([
    "npm:lodash",
    "jsr:@oak/oak",
    "https://deno.land/std@0.200.0/http/server.ts"
]);
```

## API Reference

### Loader

```typescript
class Loader {
    // Import a module
    import(specifier: string, parent?: string): Promise<unknown>;
    
    // Import synchronously
    importSync(specifier: string, parent?: string): unknown;
    
    // Resolve a module
    resolve(specifier: string, parent?: string): Promise<ModuleInfo>;
    
    // Pre-cache dependencies
    preCache(specifiers: string[]): Promise<void>;
    
    // Get cache statistics
    getCacheStats(): { total: number; cached: number; missing: number };
    
    // Clear all caches
    clearCache(): void;
    
    // Get runtime configuration
    getConfig(): RuntimeConfig;
}
```

### ModuleInfo

```typescript
interface ModuleInfo {
    id: string;                    // Unique module identifier
    url: string;                   // Canonical URL
    localPath: string;             // Local filesystem path
    format: ModuleFormat;          // ESM, CJS, etc.
    type: ModuleType;              // script, json, wasm, etc.
    protocol: string;              // file, http, npm, etc.
    isRemote: boolean;             // From remote source
    isCached: boolean;             // Cached locally
    packageName?: string;          // Package name if applicable
    packageVersion?: string;       // Package version
    packageSubpath?: string;       // Subpath within package
    attributes?: ImportAttributes; // Import attributes
}
```

## Architecture

```
cts2/
├── src/
│   ├── index.ts          # Main exports
│   ├── types.ts          # Core type definitions
│   ├── loader.ts         # Main loader class
│   ├── runtime.ts        # Module runtime
│   ├── compiler.ts       # TypeScript compiler
│   ├── commonjs.ts       # CommonJS compatibility
│   ├── utils/            # Utility modules
│   │   ├── path.ts       # Path utilities
│   │   ├── hash.ts       # Hash functions
│   │   ├── version.ts    # Version utilities
│   │   ├── json.ts       # JSON/JSONC utilities
│   │   ├── fs.ts         # File system utilities
│   │   ├── args.ts       # Argument parsing
│   │   ├── targz.ts      # Tar.gz extraction
│   │   └── cache.ts      # Cache utilities
│   ├── net/              # Network utilities
│   │   ├── url.ts        # URL utilities
│   │   └── http.ts       # HTTP client
│   ├── pkg/              # Package utilities
│   │   ├── exports.ts    # Package exports resolution
│   │   └── parse.ts      # Package specifier parsing
│   ├── resolver/         # Protocol resolvers
│   │   ├── base.ts       # Base resolver class
│   │   ├── file.ts       # File resolver
│   │   ├── data.ts       # Data URL resolver
│   │   ├── http.ts       # HTTP resolver
│   │   ├── npm.ts        # NPM resolver
│   │   ├── jsr.ts        # JSR resolver
│   │   └── node.ts       # Node.js resolver
│   └── cache/            # Cache management
│       └── index.ts      # Cache manager
├── deno.json             # Deno configuration
└── README.md             # This file
```

## License

MIT
