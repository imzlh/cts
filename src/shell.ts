// shell.ts — shell command parser + bin-wrapper script resolver

import { dirname, joinPaths, normalizePath } from './utils/path';

const engine = import.meta.use('engine');
const fs = import.meta.use('fs');

export interface CommandSegment {
    bin: string;
    args: string[];
    op?: '&&' | '||' | ';';  // operator AFTER this segment (connecting it to the next one)
}

/**
 * Split a shell command string into segments by operators.
 * `op` on segment N is the operator between segment N and N+1.
 * Handles single/double quoted strings so operators inside quotes are not split.
 */
export function parseShellCommand(input: string): CommandSegment[] {
    const segments: CommandSegment[] = [];
    let current = '';
    let i = 0;

    const flush = (op?: '&&' | '||' | ';') => {
        const trimmed = current.trim();
        if (trimmed) {
            const seg = parseSegment(trimmed);
            if (op !== undefined) seg.op = op;
            segments.push(seg);
        }
        current = '';
    };

    while (i < input.length) {
        const ch = input[i]!;

        // Handle quoted strings — consume everything inside quotes without splitting
        if (ch === '"' || ch === "'") {
            const quote = ch;
            current += ch;
            i++;
            while (i < input.length && input[i] !== quote) {
                // Handle escaped quote inside the string
                if (input[i] === '\\' && i + 1 < input.length) {
                    current += input[i]! + input[i + 1]!;
                    i += 2;
                } else {
                    current += input[i]!;
                    i++;
                }
            }
            // Closing quote
            if (i < input.length) { current += input[i]!; i++; }
            continue;
        }

        // Two-char operators first (only outside quotes)
        const two = input.slice(i, i + 2);
        if (two === '&&' || two === '||') {
            flush(two);
            i += 2;
            continue;
        }

        if (ch === ';') { flush(';'); i++; continue; }
        // '|' and '&' (single): we split on them but don't assign a named op
        if (ch === '|' || ch === '&') { flush(); i++; continue; }

        current += ch;
        i++;
    }
    flush();
    return segments;
}

/**
 * Parse a single command segment into { bin, args }.
 * Handles quoted strings: `"hello world"` becomes a single arg.
 * Strips quotes from the final tokens.
 */
function parseSegment(raw: string): CommandSegment {
    const parts: string[] = [];
    let current = '';
    let i = 0;

    while (i < raw.length) {
        const ch = raw[i]!;

        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++; // skip opening quote
            while (i < raw.length && raw[i] !== quote) {
                if (raw[i] === '\\' && i + 1 < raw.length) {
                    current += raw[i + 1]!;
                    i += 2;
                } else {
                    current += raw[i]!;
                    i++;
                }
            }
            if (i < raw.length) i++; // skip closing quote (if present — tolerate unclosed)
            continue;
        }

        if (ch === '\\' && i + 1 < raw.length) {
            current += raw[i + 1]!;
            i += 2;
            continue;
        }

        if (/\s/.test(ch)) {
            if (current) { parts.push(current); current = ''; }
            i++;
            continue;
        }

        current += ch;
        i++;
    }
    if (current) parts.push(current);

    return { bin: parts[0] || '', args: parts.slice(1) };
}

export function isShellOperator(token: string): boolean {
    return token === '&&' || token === '||' || token === ';' || token === '|' || token === '&';
}

// ---------------------------------------------------------------------------
// Bin-wrapper script parsing — extract the real JS entry so we can run it
// directly through the cno runtime instead of spawning cmd.exe / sh.
// ---------------------------------------------------------------------------

const JS_EXT = /\.(?:m|c)?jsx?$/i;

/**
 * Parse a Windows npm .cmd/.bat wrapper and return the absolute path to the
 * JS file it delegates to (relative to %dp0%, the script's own directory).
 * Returns null if the pattern isn't recognised.
 *
 * Typical npm-generated line:
 *   "%_prog%"  "%dp0%\..\vite\bin\vite.js" %*
 */
export function resolveWinBinEntry(cmdPath: string): string | null {
    try {
        const content = engine.decodeString(fs.readFile(cmdPath));
        const dir = dirname(cmdPath);   // dirname already normalizes backslashes internally

        const tryRel = (raw: string): string | null => {
            let rel = raw.replace(/\\/g, '/');
            // %~dp0 already includes the trailing slash, while %dp0% wrappers often
            // write an extra slash after the variable.  Strip any leading separator
            // left by the matcher before joining with the wrapper directory.
            rel = rel.replace(/^[/\\]+/, '');
            if (!JS_EXT.test(rel)) return null;
            const abs = normalizePath(joinPaths(dir, rel));
            return fs.exists(abs) ? abs : null;
        };

        // npm/pnpm/yarn wrappers on Windows commonly look like:
        //   "%dp0%\\..\\vite\\bin\\vite.js" %*
        //   "%~dp0\\..\\vite\\bin\\vite.js" %*
        // Match any quoted/unquoted dp0-based JS target, including uppercase .CMD
        // wrappers generated by pnpm.
        const dp0Re = /%(?:dp0%|~dp0)([/\\]?[^"'\s%\r\n]+?\.(?:m|c)?jsx?)/ig;
        let m: RegExpExecArray | null;
        while ((m = dp0Re.exec(content)) !== null) {
            const abs = tryRel(m[1]!);
            if (abs) return abs;
        }

        // Some wrappers assign a basedir/progdir variable first and use that
        // variable later.  Accept the common variable names as a second pass.
        const varRe = /%(?:_?basedir|_?progdir)%([/\\][^"'\s%\r\n]+?\.(?:m|c)?jsx?)/ig;
        while ((m = varRe.exec(content)) !== null) {
            const abs = tryRel(m[1]!);
            if (abs) return abs;
        }

        return null;
    } catch { return null; }
}

/**
 * Parse a Unix npm shell wrapper and return the absolute path to the JS file.
 * If the script itself has a Node.js shebang, return the script path as-is.
 * Returns null if the pattern isn't recognised.
 *
 * Typical npm-generated patterns:
 *   #!/usr/bin/env node          ← direct Node script, return script path
 *   exec node  "$basedir/../vite/bin/vite.js" "$@"
 */
export function resolveUnixBinEntry(shPath: string): string | null {
    try {
        const content = engine.decodeString(fs.readFile(shPath)).slice(0, 1024);
        const lines = content.split('\n');
        const first = lines[0] || '';
        if (first.startsWith('#!')) {
            const shebang = first.slice(2).trim();
            // #!/usr/bin/env node  or  #!/usr/bin/node  or  #!/usr/local/bin/node
            if (shebang.endsWith('/node') || shebang.endsWith(' node') || shebang === 'node')
                return shPath;
        }
        const dir = dirname(shPath);
        // exec node  "$basedir/../pkg/bin/cli.js"
        const m = content.match(/"\$basedir[/\\]([^"\n\r]+)/);
        if (!m) return null;
        const rel = m[1]!;
        if (!JS_EXT.test(rel)) return null;
        const abs = normalizePath(joinPaths(dir, rel));
        return fs.exists(abs) ? abs : null;
    } catch { return null; }
}

