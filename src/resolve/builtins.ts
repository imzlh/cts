export const BUILTINS = new Set([
    'assert','async_hooks','buffer','child_process','cluster','console','constants',
    'crypto','dgram','diagnostics_channel','dns','domain','events','fs','http','http2','https','inspector',
    'module','net','os','path','perf_hooks','process','punycode',
    'querystring','readline','repl','stream','string_decoder',
    'timers','tls','trace_events','tty','url','util','v8','vm',
    'wasi','worker_threads','zlib',
]);

/**
 * Builtins Node only exposes under an explicit `node:` prefix — bare `sqlite` /
 * `test` are userland package names on npm and must NOT be shadowed
 * (`require('test')` in Node is a registry package, not `node:test`).
 * `module.builtinModules` lists these in prefixed form, which is what Node does.
 */
export const PREFIXED_BUILTINS = new Set([
    'sqlite', 'test',
]);

// Only fixed dual builtins; "fs/utils" or "string_decoder/" are userland (slash bypass).
const BUILTIN_SUBPATHS = new Set([
    'fs/promises', 'dns/promises', 'stream/promises', 'stream/web', 'stream/consumers',
    'timers/promises', 'readline/promises', 'util/types',
    'assert/strict', 'path/posix', 'path/win32', 'inspector/promises',
]);

/** Subpaths of `node:`-only builtins (`node:test/reporters`). */
const PREFIXED_BUILTIN_SUBPATHS = new Set([
    'test/reporters',
]);

export function isBuiltinSpecifier(id: string): boolean {
    const prefixed = id.startsWith('node:');
    const bare = prefixed ? id.slice(5) : id;
    if (BUILTINS.has(bare)) return true;
    if (prefixed && (PREFIXED_BUILTINS.has(bare) || PREFIXED_BUILTIN_SUBPATHS.has(bare))) return true;
    return bare.includes('/') && BUILTIN_SUBPATHS.has(bare);
}

/** Node's `module.builtinModules` shape: bare names plus `node:`-only entries. */
export function builtinModuleNames(): string[] {
    return [...BUILTINS, ...[...PREFIXED_BUILTINS].map(n => `node:${n}`)];
}
