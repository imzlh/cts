// cli.ts - Command Line Interface

import { createRuntime } from './src/runtime.js';
import { createConfig, loadConfigFile } from './src/config.js';
import { errMsg, dirname, readTextFile } from './src/utils.js';

const sys = import.meta.use('sys');
const fs = import.meta.use('fs');
const os = import.meta.use('os');
const console = import.meta.use('console');
const engine = import.meta.use('engine');

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
 * Main entry point
 */
async function main(): Promise<void> {
    const entryDir = os.cwd;
    const fileConfig = loadConfigFile(entryDir);

    // Create runtime with file config
    const runtime = createRuntime(fileConfig);

    if (!runtime.rtConfig._) {
        showHelp();
        os.exit(0);
        return;
    }

    
    // Update sys.args to only include script arguments
    sys.args.splice(0, runtime.rtConfig._offset -1);
    let entryFile = runtime.rtConfig._;

    // initialize polyfill
    if (runtime.rtConfig.polyfill) try{
        const file = readTextFile(runtime.rtConfig.polyfill);
        // will eval the code in module scope
        const mod = new engine.Module(file, fs.realpath(runtime.rtConfig.polyfill));
        mod.meta.use = import.meta.use;
        await mod.eval();
    } catch (error) {
        console.error('\n❌ Error loading polyfill:', errMsg(error));
        if (error instanceof Error && error.stack) {
            console.error(error.stack);
        }
        os.exit(1);
    }

    // Resolve entry file path
    if (!entryFile.startsWith('.') && !entryFile.startsWith('/')) {
        entryFile = fs.realpath(entryFile);
    }

    try {
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