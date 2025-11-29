// cli.ts - Command Line Interface

import { createRuntime } from './src/runtime.js';
import { loadConfigFile } from './src/config.js';
import { errMsg, dirname } from './src/utils.js';

const sys = import.meta.use('sys');
const fs = import.meta.use('fs');
const os = import.meta.use('os');
const console = import.meta.use('console');

/**
 * Parse CLI arguments
 */
function parseArgs(args: string[]): {
    entryFile: string | null;
    scriptArgs: string[];
    showHelp: boolean;
    showVersion: boolean;
} {
    const result = {
        entryFile: null as string | null,
        scriptArgs: [] as string[],
        showHelp: false,
        showVersion: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;

        if (arg === '--help' || arg === '-h') {
            result.showHelp = true;
            return result;
        }

        if (arg === '--version' || arg === '-v') {
            result.showVersion = true;
            return result;
        }

        // Skip runtime options (they're handled by config.ts)
        if (arg.startsWith('--') && [
            '--cache-dir',
            '--memory-limit',
            '--max-stack-size',
            '--jsr-cache-ttl'
        ].includes(arg)) {
            i++; // Skip the next argument (the value)
            continue;
        }

        if (arg.startsWith('--no-')) {
            continue;
        }

        if (arg === '--silent') {
            continue;
        }

        // First non-option argument is the entry file
        if (!result.entryFile) {
            result.entryFile = arg;
            result.scriptArgs = args.slice(i + 1);
            break;
        }
    }

    return result;
}

/**
 * Show help message
 */
function showHelp(): void {
    console.log('TypeScript Runtime for tjs');
    console.log('');
    console.log('Usage: cjs [options] <file.ts> [args...]');
    console.log('');
    console.log('Options:');
    console.log('  --help, -h              Show this help message');
    console.log('  --version, -v           Show version information');
    console.log('  --cache-dir <path>      Set cache directory (default: ~/.cts/)');
    console.log('  --no-http               Disable HTTP module loading');
    console.log('  --no-jsr                Disable JSR module loading');
    console.log('  --no-node               Disable Node.js compatibility');
    console.log('  --silent                Suppress download logs');
    console.log('  --memory-limit <size>   Set memory limit (e.g., 256MB, 1GB)');
    console.log('  --max-stack-size <size> Set max stack size (e.g., 1MB)');
    console.log('  --jsr-cache-ttl <days>  JSR cache TTL in days (default: 7)');
    console.log('  --polyfill <file>       Load polyfill file before entry file');
    console.log('');
    console.log('Environment Variables:');
    console.log('  CTS_CACHE_DIR           Cache directory path');
    console.log('  CTS_ENABLE_HTTP         Enable/disable HTTP modules (true/false)');
    console.log('  CTS_ENABLE_JSR          Enable/disable JSR modules (true/false)');
    console.log('  CTS_ENABLE_NODE         Enable/disable Node.js compat (true/false)');
    console.log('  CTS_SILENT              Suppress logs (true/false)');
    console.log('  CTS_MEMORY_LIMIT        Memory limit (e.g., 256MB)');
    console.log('  CTS_MAX_STACK_SIZE      Max stack size (e.g., 1MB)');
    console.log('  CTS_JSR_CACHE_TTL       JSR cache TTL in days');
    console.log('');
    console.log('Built-in Features:');
    console.log('  • TypeScript/TSX/JSX support');
    console.log('  • HTTP(S) imports: https://deno.land/std/...');
    console.log('  • JSR imports: jsr:@std/path');
    console.log('  • Node.js compatibility: node:fs');
    console.log('  • npm packages from node_modules');
    console.log('  • Path aliases from tsconfig.json/deno.json');
    console.log('  • Import maps from deno.json');
    console.log('');
    console.log('Examples:');
    console.log('  cjs main.ts');
    console.log('  cjs --silent app.ts');
    console.log('  cjs --memory-limit 512MB script.ts');
    console.log('  CTS_CACHE_DIR=/tmp/cache cjs app.ts');
}

/**
 * Show version information
 */
function showVersion(): void {
    const engine = import.meta.use('engine');
    console.log(`TypeScript Runtime for tjs`);
    console.log(`tjs: ${engine.versions.tjs}`);
    console.log(`QuickJS: ${engine.versions.quickjs}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
    const args = sys.args.slice(1);
    const parsed = parseArgs(args);

    if (parsed.showHelp) {
        showHelp();
        os.exit(0);
        return;
    }

    if (parsed.showVersion) {
        showVersion();
        os.exit(0);
        return;
    }

    if (!parsed.entryFile) {
        console.error('Error: No entry file specified');
        console.error('Use --help for usage information');
        os.exit(1);
        return;
    }

    let entryFile = parsed.entryFile;

    // Resolve entry file path
    if (!entryFile.startsWith('.') && !entryFile.startsWith('/')) {
        entryFile = fs.realpath(entryFile);
    }

    // Update sys.args to only include script arguments
    sys.args.splice(1, sys.args.length - 1, ...parsed.scriptArgs);

    try {
        // Load config file from entry directory
        const entryDir = dirname(entryFile);
        const fileConfig = loadConfigFile(entryDir);

        // Create runtime with file config
        const runtime = createRuntime(fileConfig);

        // Import and execute entry file
        await import(entryFile);
    } catch (error) {
        console.error('\n❌ Runtime error:', errMsg(error));
        if (error instanceof Error && error.stack) {
            console.error(error.stack);
        }
        os.exit(1);
    }
}

// Run main
main().catch((error) => {
    console.error('\n❌ Fatal error:', errMsg(error));
    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }
    os.exit(1);
});