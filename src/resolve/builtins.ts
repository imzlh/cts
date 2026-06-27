// builtins.ts — Node.js builtin module name detection (pure string check, no IO)

export const BUILTINS = new Set([
    'assert','buffer','child_process','cluster','console','constants',
    'crypto','dgram','dns','domain','events','fs','http','http2','https','inspector',
    'module','net','os','path','perf_hooks','process','punycode',
    'querystring','readline','repl','sqlite','stream','string_decoder',
    'sqlite3','timers','tls','trace_events','tty','url','util','v8','vm',
    'worker_threads','zlib',
]);

export function isBuiltinSpecifier(id: string): boolean {
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    const slash = bare.indexOf('/');
    const head = slash === -1 ? bare : bare.slice(0, slash);
    return BUILTINS.has(head);
}
