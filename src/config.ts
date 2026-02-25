import { ModuleLoader } from './loader.js';
import type { RuntimeConfig, ConfigOptions } from './types.ts';
import { ensureDir, joinPaths, parseArgs } from './utils.js';

const os = import.meta.use('os');
const sys = import.meta.use('sys');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

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
    try {
        return os.getenv(name);
    } catch {
        // Environment variable not available
    }
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

    // CTS_DISABLE_CACHE
    const disableCache = getenv(`${ENV_PREFIX}DISABLE_CACHE`);
    if (disableCache !== null) config.disableCache = disableCache === 'true';

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
    // Determine the home directory based on the platform
    let homeDir: string | null = null;
    
    try {
        // Try to get home directory from OS module
        if (os.homedir) {
            homeDir = os.homedir;
        }
    } catch (e) {
        // If os.homedir fails, fall back to platform-specific defaults
    }
    
    // Fallback to platform-specific environment variables if needed
    if (!homeDir) {
        if (sys.platform === 'win32') {
            homeDir = getenv('USERPROFILE') || getenv('HOME') || 'C:\\Users\\Default';
        } else {
            homeDir = getenv('HOME') || '/root';
        }
    }
    
    // Handle potential null/undefined values
    if (!homeDir) {
        throw new Error('Unable to determine home directory');
    }
    
    return joinPaths(homeDir, '.cts');
}

/**
 * Create runtime configuration
 */
export function createConfig(userConfig: Partial<ConfigOptions> = {}): RuntimeConfig {
    // Priority: CLI args > user config > env vars > defaults
    const cliConfig = parseArgs(sys.args.slice(1), {
        'cache-dir': 'string',
        'silent': 'boolean',
        'memory-limit': 'string',
        'no-http': 'boolean',
        'no-jsr': 'boolean',
        'no-node': 'boolean',
        'jsr-cache-ttl': 'number',
        'polyfill': 'string',
        'disable-cache': 'boolean',
    });
    const envConfig = getEnvConfig();

    const config: RuntimeConfig = {
        cacheDir: '',
        polyfill: '',
        disableCache: false,
        ...DEFAULTS,
        ...envConfig,
        ...userConfig,
        ...cliConfig,
    };

    // Set default cache directory if not provided
    if (!config.cacheDir) {
        config.cacheDir = getDefaultCacheDir();
    }

    // Verify cache directory
    ModuleLoader.verifyCacheDir(config.cacheDir);

    // Apply engine limits if specified
    if (config.memoryLimit !== undefined) {
        engine.setMemoryLimit(config.memoryLimit);
    }

    if (config.maxStackSize !== undefined) {
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