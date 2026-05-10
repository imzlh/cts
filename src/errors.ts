// errors.ts — user-friendly error formatting and diagnostics
//
// Principles:
//   - Show what went wrong, where, and what to try next
//   - Never show an internal stack trace as the primary message
//   - Colour is used where available (same TTY detection as progress.ts)
//   - Actionable suggestions tailored to the error kind
//
// Error classification:
//   Internal errors carry a `.kind` property (ErrorKind) set at the throw site.
//   External errors (from user code, engines, or dependencies) have no `.kind`
//   and fall back to message-based heuristics — but those are best-effort only.

import { os, engine, streams, console, fs } from './utils/index';

// ---------------------------------------------------------------------------
// ErrorKind — the single source of truth for error categories
// ---------------------------------------------------------------------------

export enum ErrorKind {
    ModuleNotFound  = 'module-not-found',
    SyntaxError     = 'syntax-error',
    NetworkError    = 'network-error',
    PermissionError = 'permission-error',
    VersionNotFound = 'version-not-found',
    LockFrozen      = 'lock-frozen',
    TaskNotFound    = 'task-not-found',
    TransformError  = 'transform-error',
    ProtocolDisabled = 'protocol-disabled',
    InvalidSpecifier = 'invalid-specifier',
    FileNotFound    = 'file-not-found',
    Generic         = 'generic',
}

// Extend Error so every error can optionally carry a kind
declare global {
    interface Error {
        kind?: ErrorKind;
    }
}

// ---------------------------------------------------------------------------
// Helper: create an Error with .kind attached
// ---------------------------------------------------------------------------

/**
 * Create an Error with a .kind field.
 * Use this instead of `new Error(...)` at internal throw sites so that
 * formatError can display the correct category without guessing.
 */
export function err(kind: ErrorKind, msg: string): Error {
    const e = new Error(msg);
    e.kind = kind;
    return e;
}

// ---------------------------------------------------------------------------
// Terminal colour helpers (graceful degradation)
// ---------------------------------------------------------------------------

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
// Labels and suggestions
// ---------------------------------------------------------------------------

function label(kind: ErrorKind): string {
    switch (kind) {
        case ErrorKind.SyntaxError:      return 'Syntax Error';
        case ErrorKind.ModuleNotFound:   return 'Module Not Found';
        case ErrorKind.FileNotFound:     return 'File Not Found';
        case ErrorKind.NetworkError:     return 'Network Error';
        case ErrorKind.VersionNotFound:  return 'Version Not Found';
        case ErrorKind.LockFrozen:       return 'Lock Frozen';
        case ErrorKind.TaskNotFound:     return 'Task Not Found';
        case ErrorKind.TransformError:   return 'Transform Error';
        case ErrorKind.ProtocolDisabled: return 'Protocol Disabled';
        case ErrorKind.InvalidSpecifier: return 'Invalid Specifier';
        case ErrorKind.PermissionError:  return 'Permission Error';
        default:                         return 'Error';
    }
}

function suggest(kind: ErrorKind, msg: string): string {
    switch (kind) {
        case ErrorKind.ModuleNotFound:
            if (msg.includes('npm:') || msg.includes('node_modules'))
                return `Run ${C.cyan('cts cache <entry>')} to pre-fetch dependencies.`;
            if (msg.includes('jsr:'))
                return `Check the package name at ${C.cyan('https://jsr.io')} and try ${C.cyan('cts cache <entry>')}.`;
            return `Is the package name correct? Try ${C.cyan('cts cache <entry>')} to pre-fetch.`;

        case ErrorKind.FileNotFound:
            return 'Check the file path and extension.';

        case ErrorKind.SyntaxError:
            return 'Check the highlighted file for TypeScript/JavaScript syntax errors.';

        case ErrorKind.TransformError:
            return 'Check the file for unsupported syntax or report a bug.';

        case ErrorKind.NetworkError:
            return `Check your internet connection. Use ${C.cyan('--no-http')} to disable remote modules.`;

        case ErrorKind.VersionNotFound:
            return `Try a different version range or ${C.cyan('latest')}. Check the registry for available versions.`;

        case ErrorKind.LockFrozen:
            return `Run ${C.cyan('cts cache <entry>')} to update the lock file, then retry with ${C.cyan('--frozen')}.`;

        case ErrorKind.TaskNotFound:
            return `Run ${C.cyan('cts task --list')} to see all available tasks.`;

        case ErrorKind.PermissionError:
            return 'Check file permissions or run with appropriate privileges.';

        case ErrorKind.ProtocolDisabled:
            return 'Enable the protocol in your config or use a different module source.';

        case ErrorKind.InvalidSpecifier:
            return 'Check the module specifier format.';

        default:
            return '';
    }
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
} catch { return false; } })();

export function formatError(e: unknown, context?: string): string {
    const error = e instanceof Error ? e : new Error(String(e));
    const msg   = error.message;

    // 1. Use .kind if available (set by internal throw sites via `err()`)
    // 2. Fall back to message heuristics for external errors
    const kind = error.kind ?? classifyFallback(msg);
    const hint = suggest(kind, msg);

    const lines: string[] = [];

    // Header
    lines.push(C.bold(C.red(`✖ ${label(kind)}` + (context ? `  in ${context} ` : ''))));

    // Clean up the message — remove redundant prefixes from nested wrapping
    let cleanMsg = msg
        .replace(/^Error loading '.*?':\s*/i, '')
        .replace(/^Error:\s*/, '')
        .replace(/\(see .*?\.log\)$/, '');
    lines.push(`  ${cleanMsg}`);

    // Source context for syntax errors
    if (error instanceof SyntaxError && (error as any).cause) {
        const cause = (error as any).cause as { source?: SyntaxError; path?: string };
        if (cause.path) {
            const locMatch = cause.source?.message?.match(/(\d+):(\d+)/);
            const line = locMatch ? +locMatch[1]! : 0;
            const col  = locMatch ? +locMatch[2]! : 0;
            lines.push(C.dim(`  ${cause.path}${line ? `:${line}:${col}` : ''}`));
            if (line) lines.push(sourceContext(cause.path, line, col));
        }
    }

    // Debug stack (only if CTS_DEBUG includes 'stack')
    if (debugEnv && error.stack) {
        lines.push('', C.dim(' Stack:'));
        for (const l of error.stack.split('\n').slice(1, 6))
            lines.push(C.dim(`  ${l.trim()}`));
    } else if (error.stack) {
        const stackLines = error.stack.split('\n').filter(s => !s.includes('(native)'));
        if (stackLines[0]) {
            lines.push('    ' + C.dim(stackLines[0].trim().substring(3)));
        }
    }

    // Suggestion
    if (hint) lines.push('', `  ${C.yellow('→')} ${hint}`);

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fallback classifier — only used when .kind is absent (external errors)
// ---------------------------------------------------------------------------

function classifyFallback(msg: string): ErrorKind {
    const m = msg.toLowerCase();

    if (m.includes('syntax error') || m.includes('unexpected token') ||
        m.includes('unexpected end') || m.includes('unterminated'))
        return ErrorKind.SyntaxError;

    if (m.includes('cannot find module') || m.includes('module not found'))
        return ErrorKind.ModuleNotFound;

    if (m.includes('cannot resolve'))
        return ErrorKind.ModuleNotFound;

    if (m.includes('file not found'))
        return ErrorKind.FileNotFound;

    if (m.includes('econnrefused') || m.includes('network') ||
        m.includes('timeout') || m.includes('ssl') || m.includes('dns'))
        return ErrorKind.NetworkError;

    if (m.includes('http '))
        return ErrorKind.NetworkError;

    if (m.includes('eacces') || m.includes('eperm') || m.includes('permission'))
        return ErrorKind.PermissionError;

    if (m.includes('version') && (m.includes('not found') || m.includes('no matching')))
        return ErrorKind.VersionNotFound;

    if (/\bfrozen\b/.test(m) || /\block\b/.test(m))
        return ErrorKind.LockFrozen;

    if (m.includes('unknown task') || m.includes('task not found'))
        return ErrorKind.TaskNotFound;

    return ErrorKind.Generic;
}

// ---------------------------------------------------------------------------
// Fatal error — print and exit
// ---------------------------------------------------------------------------

export function fatal(e: unknown, context?: string): never {
    const msg = formatError(e, context) + '\n';
    console.error(msg);
    os.exit(1);
    throw new Error('unreachable');
}
