// errors.ts — user-friendly error formatting and diagnostics
//
// Principles:
//   - Show what went wrong, where, and what to try next
//   - Never show an internal stack trace as the primary message
//   - Colour is used where available (same TTY detection as progress.ts)
//   - Actionable suggestions tailored to the error kind

import { os, engine, streams, console, fs } from './utils/index';

// ---------------------------------------------------------------------------
// Terminal colour helpers (graceful degradation)
// ---------------------------------------------------------------------------

// Check stderr (fd 2) for TTY
const _isTTY: boolean = (() => {
    try { new (streams as any).TTY(2, false); return true; }
    catch { return false; }
})();
function isTTY(): boolean { return _isTTY; }

const C = {
    red:    (s: string) => isTTY() ? `\x1b[31m${s}\x1b[0m` : s,
    yellow: (s: string) => isTTY() ? `\x1b[33m${s}\x1b[0m` : s,
    cyan:   (s: string) => isTTY() ? `\x1b[36m${s}\x1b[0m` : s,
    bold:   (s: string) => isTTY() ? `\x1b[1m${s}\x1b[0m`  : s,
    dim:    (s: string) => isTTY() ? `\x1b[2m${s}\x1b[0m`  : s,
    green:  (s: string) => isTTY() ? `\x1b[32m${s}\x1b[0m` : s,
};

// ---------------------------------------------------------------------------
// Error kinds and suggestions
// ---------------------------------------------------------------------------

type ErrorKind =
    | 'module-not-found'
    | 'syntax-error'
    | 'network-error'
    | 'permission-error'
    | 'version-not-found'
    | 'lock-frozen'
    | 'task-not-found'
    | 'generic';

interface DiagInfo {
    kind:        ErrorKind;
    title:       string;
    detail?:     string;
    hint?:       string;
    location?:   { file: string; line?: number; col?: number };
    cause?:      Error;
}

function suggest(kind: ErrorKind, detail: string): string {
    switch (kind) {
        case 'module-not-found':
            if (detail.includes('npm:') || detail.includes('node_modules'))
                return `Run ${C.cyan('cts cache <entry>')} to pre-fetch dependencies.`;
            if (detail.includes('jsr:'))
                return `Check the package name at ${C.cyan('https://jsr.io')} and try ${C.cyan('cts cache <entry>')}.`;
            if (detail.includes('./') || detail.includes('../'))
                return 'Check the relative path and file extension.';
            return `Is the package name correct? Try ${C.cyan('cts cache <entry>')} to pre-fetch.`;

        case 'syntax-error':
            return 'Check the highlighted file for TypeScript/JavaScript syntax errors.';

        case 'network-error':
            return `Check your internet connection. Use ${C.cyan('--no-http')} to disable remote modules.`;

        case 'version-not-found':
            return `Try a different version range or ${C.cyan('latest')}. Check the registry for available versions.`;

        case 'lock-frozen':
            return `Run ${C.cyan('cts cache <entry>')} to update the lock file, then retry with ${C.cyan('--frozen')}.`;

        case 'task-not-found':
            return `Run ${C.cyan('cts task --list')} to see all available tasks.`;

        case 'permission-error':
            return 'Check file permissions or run with appropriate privileges.';

        default:
            return '';
    }
}

// ---------------------------------------------------------------------------
// Classifier — infer ErrorKind from error message
// ---------------------------------------------------------------------------

function classify(msg: string): ErrorKind {
    const m = msg.toLowerCase();
    if (m.includes('cannot find module') || m.includes('cannot resolve') ||
        m.includes('module not found') || m.includes('file not found'))
        return 'module-not-found';
    if (m.includes('syntax error') || m.includes('unexpected token') ||
        m.includes('unexpected end') || m.includes('unterminated'))
        return 'syntax-error';
    if (m.includes('econnrefused') || m.includes('http ') || m.includes('network') ||
        m.includes('timeout') || m.includes('ssl') || m.includes('dns'))
        return 'network-error';
    if (m.includes('eacces') || m.includes('eperm') || m.includes('permission'))
        return 'permission-error';
    if (m.includes('version') && (m.includes('not found') || m.includes('no matching')))
        return 'version-not-found';
    if (m.includes('frozen') || m.includes('lock'))
        return 'lock-frozen';
    if (m.includes('unknown task') || m.includes('task not found'))
        return 'task-not-found';
    return 'generic';
}

// ---------------------------------------------------------------------------
// Source context — show lines around the error location
// ---------------------------------------------------------------------------

function sourceContext(file: string, line: number, col: number): string {
    let src: string;
    try { src = engine.decodeString(fs.readFile(file)); }
    catch { return ''; }

    const lines = src.split('\n');
    const lo = Math.max(0, line - 2), hi = Math.min(lines.length, line + 1);
    const numW = String(hi + 1).length;
    const out: string[] = [''];

    for (let i = lo; i < hi; i++) {
        const num    = String(i + 1).padStart(numW);
        const isErr  = i === line - 1;
        const prefix = isErr ? C.red('›') : ' ';
        out.push(`  ${prefix} ${C.dim(num + ' │')} ${isErr ? C.bold(lines[i] ?? '') : (lines[i] ?? '')}`);
        if (isErr && col > 0) {
            const arrow = ' '.repeat(numW + 5 + col - 1) + C.red('^');
            out.push(arrow);
        }
    }
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main formatting function
// ---------------------------------------------------------------------------

const debugEnv = (() => { try { 
    const str = os.getenv('CTS_DEBUG') ?? '';
    if (str == '*') return true;
    if (str.includes('stack')) return true;
} catch { return false; } })()

export function formatError(e: unknown, context?: string): string {
    const err     = e instanceof Error ? e : new Error(String(e));
    const msg     = err.message;
    const kind    = classify(msg);
    const hint    = suggest(kind, msg);

    const lines: string[] = [];

    // Header
    const label = kind === 'syntax-error' ? 'Syntax Error' :
                  kind === 'module-not-found' ? 'Module Not Found' :
                  kind === 'network-error' ? 'Network Error' :
                  kind === 'version-not-found' ? 'Version Not Found' :
                  kind === 'lock-frozen' ? 'Lock Frozen' :
                  kind === 'task-not-found' ? 'Task Not Found' : 'Error';

    lines.push(C.bold(C.red(`✖ ${label}` + (context ? `  in ${context} ` : ''))));

    // Clean up the message — remove redundant prefixes that come from nested wrapping
    let cleanMsg = msg
        .replace(/^Error loading '.*?':\s*/i, '')
        .replace(/^Error:\s*/, '')
        .replace(/\(see .*?\.log\)$/, '');  // replaced by our own suggestion
    lines.push(`  ${cleanMsg}`);

    // Source context for syntax errors
    if (err instanceof SyntaxError && (err as any).cause) {
        const cause = (err as any).cause as { source?: SyntaxError; path?: string };
        if (cause.path) {
            const locMatch = cause.source?.message?.match(/(\d+):(\d+)/);
            const line = locMatch ? +locMatch[1]! : 0;
            const col  = locMatch ? +locMatch[2]! : 0;
            lines.push(C.dim(`  ${cause.path}${line ? `:${line}:${col}` : ''}`));
            if (line) lines.push(sourceContext(cause.path, line, col));
        }
    }

    // Debug stack (only if CTS_DEBUG includes 'stack')
    if (debugEnv && err.stack) {
        lines.push('', C.dim(' Stack:'));
        for (const l of err.stack.split('\n').slice(1, 6))
            lines.push(C.dim(`  ${l.trim()}`));
    } else if (err.stack) {
        // show first line
        const line = err.stack.split('\n').filter(e => !e.includes('(native)'));
        if (line[0]) {
            // remove "at "
            lines.push('    ' + C.dim(line[0].trim().substring(3)));
        }
    }
    
    // Suggestion
    if (hint) lines.push('', `  ${C.yellow('→')} ${hint}`);

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fatal error — print and exit
// ---------------------------------------------------------------------------

export function fatal(e: unknown, context?: string): never {
    const msg = formatError(e, context) + '\n';
    console.error(msg);
    os.exit(1);
    throw new Error('unreachable'); // 确保返回 never 类型，满足类型检查器
}
