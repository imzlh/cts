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

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const console = import.meta.use('console');
const worker = import.meta.use('worker');

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

export class TransformError extends Error {
    kind = ErrorKind.TransformError as const;
    fileName: string;
    line: number;
    column: number;

    constructor(message: string, fileName: string, line: number, column: number) {
        super(message);
        this.name = 'TransformError';
        this.fileName = fileName;
        this.line = line;
        this.column = column;
    }
}

// Extend Error so every error can optionally carry a kind
declare global {
    interface Error {
        kind?: ErrorKind;
    }
}

function isErrorKind(value: unknown): value is ErrorKind {
    return typeof value === 'string' && Object.values<string>(ErrorKind).includes(value);
}

function errorFromUnknown(value: unknown): Error {
    if (value instanceof Error) return value;
    if (value !== null && typeof value === 'object' && 'message' in value) {
        const out = new Error(String(Reflect.get(value, 'message')));
        const name = Reflect.get(value, 'name');
        if (typeof name === 'string') out.name = name;
        const stack = Reflect.get(value, 'stack');
        if (typeof stack === 'string') out.stack = stack;
        const kind = Reflect.get(value, 'kind');
        if (isErrorKind(kind)) out.kind = kind;
        return out;
    }
    return new Error(String(value));
}

function syntaxCause(error: SyntaxError): { source?: SyntaxError; path?: string } | null {
    const cause = Reflect.get(error, 'cause');
    if (!cause || typeof cause !== 'object') return null;
    const source = Reflect.get(cause, 'source');
    const path = Reflect.get(cause, 'path');
    return {
        source: source instanceof SyntaxError ? source : undefined,
        path: typeof path === 'string' ? path : undefined,
    };
}

// ---------------------------------------------------------------------------
// Helper: create an Error with .kind attached
// ---------------------------------------------------------------------------

/**
 * Create an Error with a .kind field.
 * Use this instead of `new Error(...)` at internal throw sites so that
 * formatError can display the correct category without guessing.
 */
export function err(kind: ErrorKind, msg: string, source?: unknown): Error {
    const e = new Error(msg);
    e.kind = kind;
    if (kind === ErrorKind.ModuleNotFound) {
        Object.defineProperty(e, 'code', {
            value: 'MODULE_NOT_FOUND',
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
    if (source !== undefined) {
        Object.defineProperty(e, 'cause', {
            value: source,
            writable: true,
            enumerable: false,
            configurable: true,
        });
    }
    if (source instanceof Error && typeof source.stack === 'string' && source.stack) {
        const nl = source.stack.indexOf('\n');
        e.stack = nl === -1
            ? `${e.name}: ${msg}`
            : `${e.name}: ${msg}\n${source.stack.slice(nl + 1)}`;
    }
    return e;
}

// ---------------------------------------------------------------------------
// Terminal colour helpers (graceful degradation)
// ---------------------------------------------------------------------------

const _isTTY: boolean = os.guessHandle(os.STDERR_FILENO) == 'tty';
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

    const lines = src.split(/\r?\n/);
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

function readDebugEnv(): string {
    try {
        return os.getenv('DEBUG') ?? '';
    } catch {
        return '';
    }
}

const debugEnv = (() => {
    const str = readDebugEnv();
    return str === '*' || str.includes('stack');
})();

export function formatError(e: unknown, context?: string): string {
    const error = errorFromUnknown(e);
    const msg   = error.message;

    // 1. Use .kind if available (set by internal throw sites via `err()`)
    // 2. Fall back to message heuristics for external errors
    const kind = error.kind ?? classifyFallback(msg);
    const hint = suggest(kind, msg);

    const lines: string[] = [];

    // Header
    lines.push(C.bold(C.red(`✖ Uncaught${(context ? ` (in ${context})` : '')} ${label(kind)}`)));

    // Clean up the message — remove redundant prefixes from nested wrapping
    let cleanMsg = msg
        .replace(/^Error loading '.*?':\s*/i, '')
        .replace(/^Error:\s*/, '')
        .replace(/\(see .*?\.log\)$/, '');
    lines.push(`  ${cleanMsg}`);

    // Source context for syntax errors
    if (error instanceof SyntaxError) {
        const cause = syntaxCause(error);
        if (cause?.path) {
            const locMatch = cause.source?.message?.match(/(\d+):(\d+)/);
            const line = locMatch?.[1] ? +locMatch[1] : 0;
            const col  = locMatch?.[2] ? +locMatch[2] : 0;
            lines.push(C.dim(`  ${cause.path}${line ? `:${line}:${col}` : ''}`));
            if (line) lines.push(sourceContext(cause.path, line, col));
        }
    }

    // Debug stack (only if DEBUG includes 'stack')
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

function errorInfo(e: unknown): { name: string; message: string; stack?: string } {
    if (e instanceof Error) {
        return {
            name: e.name,
            message: e.message,
            stack: typeof e.stack === 'string' ? e.stack : undefined,
        };
    }
    return { name: 'Error', message: String(e) };
}

// ---------------------------------------------------------------------------
// Fatal error — print and exit
// ---------------------------------------------------------------------------

export function fatal(e: unknown, context?: string): never {
    const workerData = worker.workerData;
    if (
        worker.isWorker
        && worker.pipe
        && workerData
        && typeof workerData === 'object'
        && '__node_workerData' in workerData
    ) {
        worker.pipe.postMessage({
            __cno_node_worker_error__: errorInfo(e),
        });
        if (e instanceof Error) throw e;
        throw new Error(String(e));
    }

    const msg = formatError(e, context) + '\n';
    console.error(msg);
    os.exit(1);
    throw new Error('unreachable');
}
