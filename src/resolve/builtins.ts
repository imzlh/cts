// builtins.ts — Node.js builtin module name detection (pure string check, no IO)

export const BUILTINS = new Set([
    'assert','async_hooks','buffer','child_process','cluster','console','constants',
    'crypto','dgram','diagnostics_channel','dns','domain','events','fs','http','http2','https','inspector',
    'module','net','os','path','perf_hooks','process','punycode',
    'querystring','readline','repl','sqlite','stream','string_decoder','test',
    'sqlite3','timers','tls','trace_events','tty','url','util','v8','vm',
    'wasi','worker_threads','zlib',
]);

// Node only recognizes a fixed allowlist of dual-mode "module/subpath" builtins.
// Anything else with a slash (e.g. "string_decoder/", "fs/utils") is NOT a builtin —
// old npm packages append a trailing slash specifically to bypass the core module
// and force resolution to the userland node_modules package of the same name.
const BUILTIN_SUBPATHS = new Set([
    'fs/promises', 'dns/promises', 'stream/promises', 'stream/web', 'stream/consumers',
    'timers/promises', 'readline/promises', 'util/types',
]);

export function isBuiltinSpecifier(id: string): boolean {
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    if (BUILTINS.has(bare)) return true;
    return bare.includes('/') && BUILTIN_SUBPATHS.has(bare);
}
