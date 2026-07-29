export const BUILTINS = new Set([
    'assert','async_hooks','buffer','child_process','cluster','console','constants',
    'crypto','dgram','diagnostics_channel','dns','domain','events','fs','http','http2','https','inspector',
    'module','net','os','path','perf_hooks','process','punycode',
    'querystring','readline','repl','sqlite','stream','string_decoder','test',
    'timers','tls','trace_events','tty','url','util','v8','vm',
    'wasi','worker_threads','zlib',
]);

// Only fixed dual builtins; "fs/utils" or "string_decoder/" are userland (slash bypass).
const BUILTIN_SUBPATHS = new Set([
    'fs/promises', 'dns/promises', 'stream/promises', 'stream/web', 'stream/consumers',
    'timers/promises', 'readline/promises', 'util/types',
]);

export function isBuiltinSpecifier(id: string): boolean {
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    if (BUILTINS.has(bare)) return true;
    return bare.includes('/') && BUILTIN_SUBPATHS.has(bare);
}
