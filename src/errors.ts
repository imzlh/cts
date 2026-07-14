import { getMemoryFile } from './utils/memfs';

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const console = import.meta.use('console');
const worker = import.meta.use('worker');

// ErrorKind — the single source of truth for error categories

export enum ErrorKind {
    ModuleNotFound  = 1,
    SyntaxError     = 2,
    NetworkError    = 3,
    PermissionError = 4,
    VersionNotFound = 5,
    LockFrozen      = 6,
    TaskNotFound    = 7,
    TransformError  = 8,
    ProtocolDisabled = 9,
    InvalidSpecifier = 10,
    FileNotFound    = 11,
    Generic         = 12,
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

/** True when value is a known ErrorKind (incl. Generic). */
export function isErrorKind(value: unknown): value is ErrorKind {
    // Inclusive of Generic (last enum member); `< Generic` dropped kind on duck-typed errors.
    return typeof value === 'number'
        && ErrorKind.ModuleNotFound <= value
        && value <= ErrorKind.Generic;
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

function syntaxCause(error: Error): { source?: Error; path?: string } | null {
    const cause = Reflect.get(error, 'cause');
    if (!cause || typeof cause !== 'object') return null;
    const source = Reflect.get(cause, 'source');
    const path = Reflect.get(cause, 'path');
    return {
        source: source instanceof Error ? source : undefined,
        path: typeof path === 'string' ? path : undefined,
    };
}

/** Location from first "at <module>:<line>:<col>" frame in .stack. */
function locationFromStack(source: Error | undefined): { line: number; col: number } | null {
    if (!source?.stack) return null;
    const m = source.stack.match(/^\s*at\s+.*?:(\d+):(\d+)\s*$/m);
    return m ? { line: +m[1]!, col: +m[2]! } : null;
}

// Helper: create an Error with .kind attached

/** Error with .kind for formatError. */
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

/** Resolution miss (continue CJS walk). Non-miss kinds must rethrow. */
export function isResolutionMiss(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    if (e.kind === ErrorKind.ModuleNotFound || e.kind === ErrorKind.FileNotFound) return true;
    const code = Reflect.get(e, 'code');
    return code === 'MODULE_NOT_FOUND' || code === 'ENOENT';
}

// Terminal colour helpers (graceful degradation)

const _isTTY: boolean = os.guessHandle(os.STDERR_FILENO) == 'tty';
function isTTY(): boolean { return _isTTY; }

const C = {
    red:    (s: string) => isTTY() ? `\x1b[31m${s}\x1b[0m` : s,
    yellow: (s: string) => isTTY() ? `\x1b[33m${s}\x1b[0m` : s,
    cyan:   (s: string) => isTTY() ? `\x1b[36m${s}\x1b[0m` : s,
    bold:   (s: string) => isTTY() ? `\x1b[1m${s}\x1b[0m`  : s,
    dim:    (s: string) => isTTY() ? `\x1b[2m${s}\x1b[0m`  : s,
    green:  (s: string) => isTTY() ? `\x1b[32m${s}\x1b[0m` : s,
    invert: (s: string) => isTTY() ? `\x1b[7m${s}\x1b[0m`  : s,
};

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

// Source context — show lines around the error location

function sourceContext(file: string, line: number, col: number): string {
    let src: string;
    // Prefer active VFS (pack:) so transform/syntax frames can show context.
    // Import memfs only (not utils barrel) — utils/io imports errors.
    try {
        const mem = getMemoryFile(file);
        src = engine.decodeString(mem !== undefined ? mem : fs.readFile(file));
    } catch { return ''; }

    const lines = src.split(/\r?\n/);
    // A trailing newline produces a final empty split element that isn't a
    // real source line — drop it so we don't render a bogus blank "line N+1".
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    const lo = Math.max(0, line - 2), hi = Math.min(lines.length, line + 1);
    const numW = String(hi + 1).length;
    const out: string[] = [''];

    // Fixed gutter width before line content: "  " + num + " │ "
    const gutter = numW + 5;
    const tty = isTTY();

    for (let i = lo; i < hi; i++) {
        const isErr = i === line - 1;
        const num   = String(i + 1).padStart(numW);
        // Highlight the error line via a bold/red line number instead of a
        // '›' marker glyph, which can misrender or misalign in some terminals.
        const numOut = isErr ? C.bold(C.red(num)) : C.dim(num);
        const raw = lines[i] ?? '';
        out.push(`  ${numOut} │ ${isErr ? highlightAt(raw, col, tty) : raw}`);
        // On a TTY, highlightAt already marks the offending character in
        // place — a caret line is only needed as a plain-text fallback.
        if (isErr && col > 0 && !tty) {
            const arrow = ' '.repeat(gutter + col - 1) + C.red('^');
            out.push(arrow);
        }
    }
    return out.join('\n');
}

/** Bold error line; on TTY reverse-video the char at col. */
function highlightAt(line: string, col: number, tty: boolean): string {
    if (!tty || col <= 0) return C.bold(line);
    const idx = col - 1;
    if (idx >= line.length) return C.bold(line) + C.invert(' ');
    return C.bold(line.slice(0, idx)) + C.invert(line[idx] ?? ' ') + C.bold(line.slice(idx + 1));
}

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
    const kind = error.kind ?? ErrorKind.Generic;
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

    // Syntax/transform: .cause may hold { source, path } (plain Error or SyntaxError).
    if (kind === ErrorKind.SyntaxError) {
        const cause = syntaxCause(error);
        if (cause?.path) {
            const locMatch = cause.source?.message?.match(/(\d+):(\d+)/);
            const loc = locMatch?.[1]
                ? { line: +locMatch[1], col: locMatch[2] ? +locMatch[2] : 0 }
                : locationFromStack(cause.source);
            lines.push(C.dim(`  ${cause.path}${loc ? `:${loc.line}:${loc.col}` : ''}`));
            if (loc) lines.push(sourceContext(cause.path, loc.line, loc.col));
        }
    } else if (error instanceof TransformError) {
        lines.push(C.dim(`  ${error.fileName}:${error.line}:${error.column}`));
        lines.push(sourceContext(error.fileName, error.line, error.column));
    }

    // Debug stack (only if DEBUG includes 'stack')
    if (debugEnv && error.stack) {
        lines.push('', C.dim(' Stack:'));
        for (const l of error.stack.split('\n').slice(1, 6))
            lines.push(C.dim(`  ${l.trim()}`));
    } else if (error.stack) {
        // stack[0] is the "Name: message" header (already shown above via
        // cleanMsg) — the first actual call site starts at index 1.
        const frame = error.stack.split('\n').slice(1)
            .map(l => l.trim())
            .find(l => l && !l.includes('(native)'));
        if (frame) {
            lines.push('    ' + C.dim(frame.startsWith('at ') ? frame.slice(3) : frame));
        }
    }

    // Suggestion
    if (hint) lines.push('', `  ${C.yellow('→')} ${hint}`);

    return lines.join('\n');
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

// Fatal error — print and exit

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
