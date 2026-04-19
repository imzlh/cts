// task.ts — `deno.json` task runner
//
// Supports:
//   tasks: { "name": "command string" }
//   tasks: { "name": { "command": "...", "dependencies": [...], "env": {...} } }
//
// `deno run [flags] <file>` in task commands is translated to a direct cts
// re-invocation so the same cache/lock settings apply.  All other commands
// are executed through the OS shell.

import { dirname, joinPaths } from './utils/path';
import { readText } from './utils/io';
import { stripJsonc, safeParse, errMsg } from './utils/misc';
import { sys, fs, process, console } from './utils/index';
import { log } from './utils/log';



// ---------------------------------------------------------------------------
// deno.json task schema
// ---------------------------------------------------------------------------

type TaskDef = string | {
    command: string;
    dependencies?: string[];
    env?: Record<string, string>;
};

interface DenoConfig {
    tasks?: Record<string, TaskDef>;
}

// ---------------------------------------------------------------------------
// Deno flag stripping
// All deno-specific flags that have no cts equivalent are dropped.
// ---------------------------------------------------------------------------

// Flags that consume the next token as a value
const DENO_VALUE_FLAGS = new Set([
    '--config', '-c', '--import-map', '--lock', '--lock-write',
    '--cert', '--inspect', '--inspect-brk', '--inspect-wait',
    '--node-modules-dir', '--vendor', '--env-file',
    '--reload', '-r', '--seed', '--v8-flags',
    '--location', '--log-level',
]);

// Boolean flags to drop silently
const DENO_BOOL_FLAGS = new Set([
    '--allow-all', '-A', '--allow-env', '--allow-read', '--allow-write',
    '--allow-net', '--allow-run', '--allow-ffi', '--allow-hrtime',
    '--allow-sys', '--deny-env', '--deny-read', '--deny-write',
    '--deny-net', '--deny-run', '--deny-ffi', '--deny-sys',
    '--no-check', '--check', '--no-lock', '--no-npm', '--no-remote',
    '--unstable', '--unstable-bare-node-builtins', '--unstable-byonm',
    '--unstable-sloppy-imports', '--unstable-workspaces',
    '--quiet', '-q', '--watch', '--watch-exclude',
    '--frozen',
]);

/**
 * Given the tokens after `deno run`, return [entryFile, ...args]
 * with all deno-specific flags stripped.
 */
function stripDenoRunFlags(tokens: string[]): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < tokens.length) {
        const t = tokens[i]!;
        if (!t.startsWith('-')) {
            // First non-flag = the entry file; everything after goes through unchanged
            out.push(...tokens.slice(i));
            break;
        }
        // Handle --flag=value form
        const eq = t.indexOf('=');
        const flag = eq !== -1 ? t.slice(0, eq) : t;
        if (DENO_VALUE_FLAGS.has(flag)) {
            // Skip flag + value (unless already attached with =)
            if (eq === -1) i++;
        } else if (!DENO_BOOL_FLAGS.has(flag)) {
            // Unknown flag — pass through (might be cts flags like --silent)
            out.push(t);
        }
        i++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Command parsing and execution
// ---------------------------------------------------------------------------

/**
 * Split a command string into tokens, respecting single and double quotes.
 * Does NOT handle subshells, escapes, or other advanced shell features.
 */
function tokenize(cmd: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '' | '"' | "'" = '';
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i]!;
        if (quote) {
            if (c === quote) quote = '';
            else current += c;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === ' ' || c === '\t') {
            if (current) { tokens.push(current); current = ''; }
        } else {
            current += c;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

/**
 * Execute a single command string.
 * If it starts with `deno run`, rewrites to a cts invocation.
 * Otherwise, runs through the OS shell.
 */
async function execCommand(
    cmd: string,
    env: Record<string, string>,
    cwd: string,
    extraArgs: string[],
): Promise<number> {
    const tokens = tokenize(cmd.trim());
    if (!tokens.length) return 0;

    let argv: string[];
    let prog: string;

    // Detect `deno run [flags] <file> [args]`
    if (tokens[0] === 'deno' && tokens[1] === 'run') {
        const stripped = stripDenoRunFlags(tokens.slice(2));
        if (!stripped.length) {
            console.error('[task] `deno run` with no entry file');
            return 1;
        }
        // Re-invoke ourselves: cts <stripped...> <extraArgs...>
        prog = sys.exePath;
        argv = [...stripped, ...extraArgs];
        log.debug('task', () => `deno run → cts ${argv.join(' ')}`);
    } else if (tokens[0] === 'deno' && tokens[1] === 'task') {
        // Nested `deno task <name>` — just re-exec ourselves
        prog = sys.exePath;
        argv = ['task', ...(tokens.slice(2)), ...extraArgs];
    } else {
        // Generic shell command
        const shell = sys.platform === 'win32' ? 'cmd' : '/bin/sh';
        const shellArg = sys.platform === 'win32' ? '/c' : '-c';
        // Append extra args to the command string
        const fullCmd = extraArgs.length
            ? `${cmd} ${extraArgs.map(a => JSON.stringify(a)).join(' ')}`
            : cmd;
        prog = shell;
        argv = [shellArg, fullCmd];
    }

    // Merge env
    const mergedEnv: Record<string, string> = {};
    // We can't enumerate the current env in QuickJS easily, so we rely on
    // spawn inheriting it and only passing the extras.
    const child = process.spawn(prog, argv, {
        stdin:  'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        // env merge is not supported in all runtimes; pass extras via workaround
        // In practice, spawn inherits the parent env automatically.
    });

    // Set task-local env vars before spawning isn't universally possible.
    // For now, prefix them to the shell command.
    // TODO: if process.spawn gains env support, use it here.

    const info = await child.wait();
    return info.exit_status ?? 0;
}

// ---------------------------------------------------------------------------
// Task graph
// ---------------------------------------------------------------------------

export class TaskRunner {
    private readonly tasks: Record<string, TaskDef>;
    private readonly cwd: string;
    private readonly done = new Set<string>();

    constructor(tasks: Record<string, TaskDef>, cwd: string) {
        this.tasks = tasks;
        this.cwd   = cwd;
    }

    list(): void {
        const names = Object.keys(this.tasks);
        if (!names.length) {
            console.log('  \x1b[2mNo tasks defined in this config.\x1b[0m');
            return;
        }
        const maxLen = names.reduce((m, n) => Math.max(m, n.length), 0);
        for (const name of names) {
            const def  = this.tasks[name]!;
            const cmd  = typeof def === 'string' ? def : def.command;
            const deps = typeof def === 'string' ? [] : (def.dependencies ?? []);
            const pad  = ' '.repeat(maxLen - name.length + 2);
            const depStr = deps.length ? `  \x1b[2m← needs: ${deps.join(', ')}\x1b[0m` : '';
            console.log(`  \x1b[36m${name}\x1b[0m${pad}\x1b[2m${cmd}\x1b[0m${depStr}`);
        }
    }

    async run(name: string, extraArgs: string[] = []): Promise<number> {
        const def = this.tasks[name];
        if (!def) {
            const names = Object.keys(this.tasks);
            console.error(`\x1b[31m✖ Unknown task:\x1b[0m ${name}`);
            if (names.length) {
                console.error(`  Available: ${names.map(n => `\x1b[36m${n}\x1b[0m`).join(', ')}`);
            } else {
                console.error(`  \x1b[2mNo tasks defined. Add a "tasks" field to deno.json.\x1b[0m`);
            }
            return 1;
        }

        const command = typeof def === 'string' ? def : def.command;
        const deps    = typeof def === 'string' ? [] : (def.dependencies ?? []);
        const env     = typeof def === 'string' ? {} : (def.env ?? {});

        // Run dependencies first (DFS, skip already-done)
        for (const dep of deps) {
            if (this.done.has(dep)) continue;
            const code = await this.run(dep);
            if (code !== 0) {
                console.error(`\x1b[31m✖ Dependency task \x1b[36m${dep}\x1b[0m\x1b[31m failed (exit ${code})\x1b[0m`);
                return code;
            }
        }

        if (this.done.has(name)) return 0;
        this.done.add(name);

        console.log(`\n\x1b[32m$ ${command}\x1b[0m`);
        // Only pass extra args to the leaf task, not to dependencies
        const code = await execCommand(command, env, this.cwd, extraArgs);
        if (code !== 0) console.error(`\x1b[31m✖ Task \x1b[36m${name}\x1b[0m\x1b[31m exited with code ${code}\x1b[0m`);
        return code;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Find and load the nearest deno.json/deno.jsonc containing a `tasks` field. */
export function loadTasks(startDir: string): { runner: TaskRunner; configPath: string } | null {
    let dir = startDir;
    while (dir !== '/' && dir !== '.') {
        for (const name of ['deno.json', 'deno.jsonc']) {
            const p = joinPaths(dir, name);
            if (!fs.exists(p)) continue;
            try {
                const cfg = safeParse<DenoConfig>(stripJsonc(readText(p)));
                if (cfg.tasks && typeof cfg.tasks === 'object') {
                    return { runner: new TaskRunner(cfg.tasks, dir), configPath: p };
                }
            } catch (e) {
                log.warn('task', () => `Failed to parse ${p}: ${errMsg(e)}`);
            }
        }
        const up = dirname(dir); if (up === dir) break; dir = up;
    }
    return null;
}
