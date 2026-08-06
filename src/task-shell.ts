/**
 * Internal task shell — parity with `deno task` (deno_task_shell), not with a
 * POSIX shell and not with cmd.exe.
 *
 * Why this exists: `taskShellArgv()` used to hand the whole task script to
 * `cmd.exe /c` on Windows. That is wrong twice over.
 *   1. cmd.exe does not strip POSIX quotes and does not expand `$VAR`
 *      (it expands `%VAR%`), so `echo "hi"` printed `"hi"` and `echo $FOO`
 *      printed `$FOO`.
 *   2. Handing a script containing `"` to cmd.exe through an argv-based spawn
 *      API applies MSVCRT quoting, which cmd.exe does not parse — the string
 *      arrives with backslashes that were never in the source. Verified: real
 *      deno's own spawn does the same, which is precisely why deno never
 *      delegates task scripts to cmd.exe.
 *
 * Scope is deliberately bounded to the subset below. Anything outside it makes
 * `parseTaskScript` return null so the caller keeps its previous cmd.exe/sh
 * behaviour — this never regresses a script that used to work.
 *
 * SUPPORTED: single quotes (fully literal), double quotes (`$VAR` expands,
 *   `\"` `\\` `\$` escape), unquoted words (`\x` escapes, `$VAR` expands and
 *   word-splits), adjacent-part concatenation (`a"b"c` -> `abc`),
 *   operators `&&` `||` `;` `|`, redirections `>` `>>`.
 * NOT SUPPORTED (-> null, fall back): `$(...)`, backticks, globs `* ? [`,
 *   leading `~`, background `&`, input redirection `<`, fd-qualified
 *   redirection such as `2>`.
 *
 * Matches deno on purpose: `${FOO}` is NOT expanded (deno leaves it literal),
 * an unset variable expands to the empty string, and `''` stays a real empty
 * argument.
 */

export type TaskOperator = '&&' | '||' | ';';
export type RedirectOp = '>' | '>>';

export interface TaskRedirect {
    op: RedirectOp;
    /** Unexpanded target word; expanded at exec time. */
    target: Word;
}

export interface TaskCommand {
    /** Unexpanded words; expanded at exec time so env is honoured. */
    words: Word[];
    redirect?: TaskRedirect;
}

/** One pipeline (`a | b | c`) plus the operator joining it to the next. */
export interface TaskPipeline {
    commands: TaskCommand[];
    op?: TaskOperator;
}

export type WordPart =
    | { kind: 'lit'; value: string }
    | { kind: 'var'; name: string; quoted: boolean };

export interface Word {
    parts: WordPart[];
    /** True when the word contained a quote, so `''` survives as an empty arg. */
    quoted: boolean;
}

const VAR_START = /[A-Za-z_]/;
const VAR_CHAR = /[A-Za-z0-9_]/;

/** Characters that put a script outside the supported subset. */
function isUnsupportedBare(ch: string): boolean {
    return ch === '`' || ch === '*' || ch === '?' || ch === '[' || ch === '<';
}

interface Lexed {
    words: Word[];
    /** Operators interleaved between words, recorded with their word index. */
    ops: Array<{ at: number; op: TaskOperator | '|' | RedirectOp }>;
}

/**
 * Lex a script into words plus positioned operators.
 * Returns null when the script leaves the supported subset.
 */
function lex(script: string): Lexed | null {
    const words: Word[] = [];
    const ops: Array<{ at: number; op: TaskOperator | '|' | RedirectOp }> = [];

    let parts: WordPart[] = [];
    let quoted = false;
    let started = false;
    let lit = '';

    const pushLit = () => {
        if (lit) {
            parts.push({ kind: 'lit', value: lit });
            lit = '';
        }
    };
    const endWord = () => {
        pushLit();
        if (started) words.push({ parts, quoted });
        parts = [];
        quoted = false;
        started = false;
    };
    const pushOp = (op: TaskOperator | '|' | RedirectOp) => {
        endWord();
        ops.push({ at: words.length, op });
    };

    let i = 0;
    while (i < script.length) {
        const ch = script.charAt(i);

        // Single quotes: everything literal until the closing quote.
        if (ch === "'") {
            started = true;
            quoted = true;
            i++;
            const close = script.indexOf("'", i);
            if (close === -1) return null; // unterminated
            lit += script.slice(i, close);
            i = close + 1;
            continue;
        }

        // Double quotes: $VAR expands; \" \\ \$ escape; other backslashes literal.
        if (ch === '"') {
            started = true;
            quoted = true;
            i++;
            let closed = false;
            while (i < script.length) {
                const c = script.charAt(i);
                if (c === '"') { closed = true; i++; break; }
                if (c === '\\') {
                    const next = script.charAt(i + 1);
                    if (next === '"' || next === '\\' || next === '$' || next === '`') {
                        lit += next;
                        i += 2;
                        continue;
                    }
                    lit += '\\';
                    i++;
                    continue;
                }
                if (c === '`') return null;
                if (c === '$') {
                    const read = readVar(script, i);
                    if (read === null) return null;      // $( … ) — unsupported
                    if (read === undefined) { lit += '$'; i++; continue; }  // literal $
                    pushLit();
                    parts.push({ kind: 'var', name: read.name, quoted: true });
                    i = read.next;
                    continue;
                }
                lit += c;
                i++;
            }
            if (!closed) return null; // unterminated
            continue;
        }

        if (ch === '\\') {
            const next = script.charAt(i + 1);
            if (next === '') return null;
            started = true;
            lit += next;
            i += 2;
            continue;
        }

        if (ch === '$') {
            const read = readVar(script, i);
            if (read === null) return null;
            if (read === undefined) { started = true; lit += '$'; i++; continue; }
            started = true;
            pushLit();
            parts.push({ kind: 'var', name: read.name, quoted: false });
            i = read.next;
            continue;
        }

        // Operators (only outside quotes).
        const two = script.slice(i, i + 2);
        if (two === '&&' || two === '||') { pushOp(two); i += 2; continue; }
        if (two === '>>') { pushOp('>>'); i += 2; continue; }
        if (ch === ';') { pushOp(';'); i++; continue; }
        if (ch === '|') { pushOp('|'); i++; continue; }
        if (ch === '>') { pushOp('>'); i++; continue; }
        // Lone `&` is a background job — outside the subset.
        if (ch === '&') return null;

        if (isUnsupportedBare(ch)) return null;
        // Leading `~` is home expansion — outside the subset.
        if (ch === '~' && !started) return null;

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            endWord();
            i++;
            continue;
        }

        started = true;
        lit += ch;
        i++;
    }
    endWord();
    return { words, ops };
}

/**
 * Read a `$NAME` reference at `i`.
 * Returns the name and next index, `undefined` for a literal `$`
 * (including deno's literal `${...}`), or null for unsupported `$(`.
 */
function readVar(script: string, i: number): { name: string; next: number } | undefined | null {
    const next = script.charAt(i + 1);
    if (next === '(') return null;          // command substitution
    if (next === '{') return undefined;     // deno leaves ${FOO} literal
    if (!VAR_START.test(next)) return undefined;
    let j = i + 1;
    while (j < script.length && VAR_CHAR.test(script.charAt(j))) j++;
    return { name: script.slice(i + 1, j), next: j };
}

/**
 * Parse a task script into pipelines. Returns null when the script uses
 * syntax outside the supported subset — the caller must then fall back.
 */
export function parseTaskScript(script: string): TaskPipeline[] | null {
    const lexed = lex(script);
    if (!lexed) return null;
    const { words, ops } = lexed;
    if (!words.length) return null;

    const opAt = new Map<number, TaskOperator | '|' | RedirectOp>();
    for (const entry of ops) {
        // Two operators in a row (`a && && b`) is a syntax error, not a subset gap.
        if (opAt.has(entry.at)) return null;
        opAt.set(entry.at, entry.op);
    }

    const pipelines: TaskPipeline[] = [];
    let commands: TaskCommand[] = [];
    let current: TaskCommand = { words: [] };
    let pendingRedirect: RedirectOp | null = null;

    const endCommand = (): boolean => {
        if (pendingRedirect) return false;         // dangling `>`
        if (!current.words.length && !current.redirect) return false;
        commands.push(current);
        current = { words: [] };
        return true;
    };
    const endPipeline = (op?: TaskOperator): boolean => {
        if (!endCommand()) return false;
        pipelines.push(op ? { commands, op } : { commands });
        commands = [];
        return true;
    };

    for (let w = 0; w <= words.length; w++) {
        const op = opAt.get(w);
        if (op) {
            if (op === '>' || op === '>>') {
                // Redirection binds to the command being built; target is next word.
                if (pendingRedirect) return null;
                pendingRedirect = op;
            } else if (op === '|') {
                if (!endCommand()) return null;
            } else {
                if (!endPipeline(op)) return null;
            }
        }
        if (w === words.length) break;
        const word = words[w];
        if (!word) return null;
        if (pendingRedirect) {
            if (current.redirect) return null;      // two redirects on one command
            current.redirect = { op: pendingRedirect, target: word };
            pendingRedirect = null;
            continue;
        }
        current.words.push(word);
    }

    if (pendingRedirect) return null;
    if (!endPipeline()) return null;
    // A trailing operator with nothing after it is a syntax error.
    return pipelines;
}

/** Expand one word to zero or more arguments (unquoted `$VAR` word-splits). */
export function expandWord(word: Word, env: Record<string, string | undefined>): string[] {
    let currentArg = '';
    let hasArg = word.quoted;
    const out: string[] = [];

    for (const part of word.parts) {
        if (part.kind === 'lit') {
            currentArg += part.value;
            hasArg = true;
            continue;
        }
        const value = env[part.name] ?? '';
        if (part.quoted) {
            currentArg += value;
            hasArg = true;
            continue;
        }
        // Unquoted expansion: split on whitespace, like deno.
        const pieces = value.split(/[ \t\n\r]+/);
        for (let p = 0; p < pieces.length; p++) {
            const piece = pieces[p] ?? '';
            if (p === 0) {
                currentArg += piece;
                if (piece) hasArg = true;
                continue;
            }
            if (hasArg || currentArg) out.push(currentArg);
            currentArg = piece;
            hasArg = piece.length > 0;
        }
    }
    if (hasArg || currentArg) out.push(currentArg);
    return out;
}

/** Expand a command's words into a concrete argv. */
export function expandArgv(cmd: TaskCommand, env: Record<string, string | undefined>): string[] {
    const argv: string[] = [];
    for (const word of cmd.words) argv.push(...expandWord(word, env));
    return argv;
}

/** Expand a redirect target; null when it does not resolve to exactly one path. */
export function expandRedirectTarget(
    redirect: TaskRedirect,
    env: Record<string, string | undefined>,
): string | null {
    const parts = expandWord(redirect.target, env);
    return parts.length === 1 ? parts[0] ?? null : null;
}
