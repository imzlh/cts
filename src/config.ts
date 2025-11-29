// config.ts - Runtime Configuration Management
import type { RuntimeConfig, ConfigOptions } from './types.ts';

const os = import.meta.use('os');
const sys = import.meta.use('sys');
const fs = import.meta.use('fs');
const console = import.meta.use('console');

/**
 * Environment variable prefix for configuration
 */
const ENV_PREFIX = 'CTS_';

/**
 * Default configuration values
 */
const DEFAULTS = {
    enableHttp: true,
    enableJsr: true,
    enableNode: true,
    silent: false,
    jsrCacheTTL: 7 * 24 * 60 * 60 * 1000, // 1 week
    memoryLimit: undefined,
    maxStackSize: undefined,
} as const;

/**
 * Parse command line arguments for configuration
 */
function parseCliArgs(args: string[]): Partial<ConfigOptions> {
    const config: Partial<ConfigOptions> = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--cache-dir':
                config.cacheDir = args[++i];
                break;
            case '--no-http':
                config.enableHttp = false;
                break;
            case '--no-jsr':
                config.enableJsr = false;
                break;
            case '--no-node':
                config.enableNode = false;
                break;
            case '--silent':
                config.silent = true;
                break;
            case '--memory-limit': {
                const limit = args[++i];
                config.memoryLimit = parseMemorySize(limit);
                break;
            }
            case '--max-stack-size': {
                const size = args[++i];
                config.maxStackSize = parseMemorySize(size);
                break;
            }
            case '--jsr-cache-ttl': {
                const days = parseInt(args[++i] ?? '7', 10);
                config.jsrCacheTTL = days * 24 * 60 * 60 * 1000;
                break;
            }
            case '--polyfill': {
                const file = args[++i];
                if (!file) throw new Error('Missing polyfill file');
                import(file).then(module => {
                    config.polyfill = true;
                }).catch(e => {
                    console.error('Failed to load polyfill:', e);
                });
                break;
            }
        }
    }

    return config;
}

/**
 * Parse memory size string (e.g., "256MB", "1GB")
 */
function parseMemorySize(size: string | undefined): number | undefined {
    if (!size) return undefined;

    const units: Record<string, number> = {
        'B': 1,
        'KB': 1024,
        'MB': 1024 * 1024,
        'GB': 1024 * 1024 * 1024,
    };

    const match = size.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)?$/i);
    if (!match) {
        throw new Error(`Invalid memory size format: ${size}`);
    }

    const [, num, unit = 'B'] = match;
    const multiplier = units[unit.toUpperCase()] ?? 1;

    return Math.floor(parseFloat(num!) * multiplier);
}

/**
 * getenv wrapper, with error handling
 */
function getenv(name: string): string | null {
    try{
        return os.getenv(name);
    }catch{}
    return null;
}

/**
 * Get environment variable configuration
 */
function getEnvConfig(): Partial<ConfigOptions> {
    const config: Partial<ConfigOptions> = {};

    // CTS_CACHE_DIR
    const cacheDir = getenv(`${ENV_PREFIX}CACHE_DIR`);
    if (cacheDir) config.cacheDir = cacheDir;

    // CTS_ENABLE_HTTP
    const enableHttp = getenv(`${ENV_PREFIX}ENABLE_HTTP`);
    if (enableHttp !== null) config.enableHttp = enableHttp === 'true';

    // CTS_ENABLE_JSR
    const enableJsr = getenv(`${ENV_PREFIX}ENABLE_JSR`);
    if (enableJsr !== null) config.enableJsr = enableJsr === 'true';

    // CTS_ENABLE_NODE
    const enableNode = getenv(`${ENV_PREFIX}ENABLE_NODE`);
    if (enableNode !== null) config.enableNode = enableNode === 'true';

    // CTS_SILENT
    const silent = getenv(`${ENV_PREFIX}SILENT`);
    if (silent !== null) config.silent = silent === 'true';

    // CTS_MEMORY_LIMIT
    const memoryLimit = getenv(`${ENV_PREFIX}MEMORY_LIMIT`);
    if (memoryLimit) config.memoryLimit = parseMemorySize(memoryLimit);

    // CTS_MAX_STACK_SIZE
    const maxStackSize = getenv(`${ENV_PREFIX}MAX_STACK_SIZE`);
    if (maxStackSize) config.maxStackSize = parseMemorySize(maxStackSize);

    // CTS_JSR_CACHE_TTL (in days)
    const jsrCacheTTL = getenv(`${ENV_PREFIX}JSR_CACHE_TTL`);
    if (jsrCacheTTL) {
        const days = parseInt(jsrCacheTTL, 10);
        config.jsrCacheTTL = days * 24 * 60 * 60 * 1000;
    }

    return config;
}

/**
 * Get default cache directory (like Deno)
 */
function getDefaultCacheDir(): string {
    const home = os.homedir || (sys.platform === 'win32' ? 'C:\\Users\\Default' : '/root');
    return joinPaths(home, '.cts');
}

/**
 * Join path segments
 */
function joinPaths(...segments: string[]): string {
    return segments.filter(Boolean).join('/').replace(/\/+/g, '/');
}

/**
 * Ensure directory exists
 */
function ensureDir(dir: string): void {
    if (fs.exists(dir)) return;

    const parent = dirname(dir);
    if (parent && parent !== dir && parent !== '.') {
        ensureDir(parent);
    }

    try {
        fs.mkdir(dir, 0o755);
    } catch (error) {
        if (!fs.exists(dir)) throw error;
    }
}

/**
 * Get directory name
 */
function dirname(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash > 0 ? normalized.substring(0, lastSlash) : '.';
}

/**
 * Create runtime configuration
 */
export function createConfig(userConfig: Partial<ConfigOptions> = {}): RuntimeConfig {
    // Priority: CLI args > user config > env vars > defaults
    const cliConfig = parseCliArgs(sys.args.slice(1));
    const envConfig = getEnvConfig();

    const config: RuntimeConfig = {
        cacheDir: '',
        polyfill: false,
        ...DEFAULTS,
        ...envConfig,
        ...userConfig,
        ...cliConfig,
    };

    // Set default cache directory if not provided
    if (!config.cacheDir) {
        config.cacheDir = getDefaultCacheDir();
    }

    // Ensure cache directory exists
    ensureDir(config.cacheDir);

    // Apply engine limits if specified
    if (config.memoryLimit !== undefined) {
        const engine = import.meta.use('engine');
        engine.setMemoryLimit(config.memoryLimit);
    }

    if (config.maxStackSize !== undefined) {
        const engine = import.meta.use('engine');
        engine.setMaxStackSize(config.maxStackSize);
    }

    return config;
}

/**
 * Load configuration from file (tsconfig.json or deno.json)
 */
export function loadConfigFile(dir: string): Partial<ConfigOptions> {
    const jsonc = import.meta.use('jsonc');
    const config: Partial<ConfigOptions> = {};

    // Try tsconfig.json
    const tsconfigPath = joinPaths(dir, 'tsconfig.json');
    if (fs.exists(tsconfigPath)) {
        try {
            const engine = import.meta.use('engine');
            const buffer = fs.readFile(tsconfigPath);
            const content = engine.decodeString(buffer);
            const tsconfig = jsonc.parse(content);

            if (tsconfig?.compilerOptions?.paths) {
                config.pathAliases = tsconfig.compilerOptions.paths;
            }

            if (tsconfig?.compilerOptions?.baseUrl) {
                config.baseUrl = joinPaths(dir, tsconfig.compilerOptions.baseUrl);
            }
        } catch {
            // Ignore errors
        }
    }

    // Try deno.json / deno.jsonc
    for (const filename of ['deno.json', 'deno.jsonc']) {
        const denoConfigPath = joinPaths(dir, filename);
        if (fs.exists(denoConfigPath)) {
            try {
                const engine = import.meta.use('engine');
                const buffer = fs.readFile(denoConfigPath);
                const content = engine.decodeString(buffer);
                const denoConfig = jsonc.parse(content);

                if (denoConfig?.imports) {
                    config.importMap = denoConfig.imports;
                }

                if (denoConfig?.compilerOptions?.paths) {
                    config.pathAliases = denoConfig.compilerOptions.paths;
                }
            } catch {
                // Ignore errors
            }
            break;
        }
    }

    return config;
}

export { parseMemorySize, getDefaultCacheDir };