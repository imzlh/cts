// task.ts — `deno.json` task runner
//
// Supports:
//   tasks: { "name": "command string" }
//   tasks: { "name": { "command": "...", "dependencies": [...], "env": {...} } }
//
// `deno run [flags] <file>` in task commands is translated to a direct cts
// re-invocation so the same cache/lock settings apply.  All other commands
// are resolved via BinResolver (lock bin index + node_modules/.bin) and
// executed directly. If a command cannot be resolved as a bin, it fails.

import { dirname, joinPaths, pathRoot, toPosixPath } from './utils/path';
import { readText } from './utils/io';
import { stripJsonc, safeParse, errMsg, matchLatestVersion } from './utils/misc';
import { log } from './utils/log';
import { isWindows } from './utils/index';
import { parseShellCommand, resolveWinBinEntry, resolveUnixBinEntry } from './shell';
import { LockStore } from './lock';
import { findLocalBin, WIN_BIN_EXTS } from './utils/bin';
import { getBinMap, readPkgFresh } from './pkg';

const os = import.meta.use('os');
const console = import.meta.use('console');
const fs = import.meta.use('fs');
const process = import.meta.use('process');

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
// Bin resolver — resolves command names to executable paths
// ---------------------------------------------------------------------------

export interface ResolvedBin {
    /** Absolute path to the JS entry file (runnable by cts directly) */
    entry: string;
    /** Original bin path (.cmd, shell wrapper, etc.) before resolution */
    binPath: string;
    /** True if we had to fall back to cmd.exe / sh because the wrapper couldn't be parsed */
    fallback: boolean;
    /** Short explanation useful for debugging resolver decisions */
    reason?: string;
}

export class BinResolver {
    private readonly isWin: boolean;

    constructor(private lockStore: LockStore) {
        this.isWin = isWindows;
    }

    /**
     * Resolve a binary name to a runnable JS entry path.
     * Priority: local node_modules/.bin > lock bin index.
     * Returns null if name looks like a path or flag, or if the binary cannot be found.
     *
     * When possible, parses .cmd/.bat/shell wrappers to extract the real JS
     * entry so it can be run directly by the cts runtime.
     */
    resolve(name: string, cwd: string): ResolvedBin | null {
        if (name.startsWith('/') || name.startsWith('.') || name.includes('/')) return null;
        if (name.startsWith('-')) return null;

        // 1. Local node_modules/.bin
        const local = findLocalBin(name, cwd);
        if (local) return this.resolveEntry(local);

        // 2. Lock bin index
        const lockBin = this.lockStore.getBin(name);
        if (lockBin) return this.resolveEntry(lockBin.path);

        // 3. Cache fallback from direct project deps/devDeps when node_modules is absent.
        const cached = this.resolveCachedProjectBin(name, cwd);
        if (cached) return this.resolveEntry(cached);

        return null;
    }

    private resolveCachedProjectBin(name: string, cwd: string): string | null {
        const pkgDir = findNearestPackageDir(cwd);
        if (!pkgDir) return null;
        const pkg = readPkgFresh(pkgDir);
        if (!pkg) return null;

        const deps = [
            ...(pkg.dependencies ? Object.entries(pkg.dependencies) : []),
            ...(pkg.devDependencies ? Object.entries(pkg.devDependencies) : []),
            ...(pkg.optionalDependencies ? Object.entries(pkg.optionalDependencies) : []),
        ];

        // Prefer a direct package-name match first, then scan the rest for custom bin names.
        deps.sort(([a], [b]) => (a === name ? -1 : b === name ? 1 : 0));

        const cacheDir = resolveCacheDir();
        for (const [pkgName, range] of deps) {
            if (typeof range !== 'string' || !range) continue;
            const installedDir = findCachedPackageDir(cacheDir, pkgName, range);
            if (!installedDir) continue;
            const cachedPkg = readPkgFresh(installedDir);
            if (!cachedPkg) continue;
            const binMap = getBinMap(cachedPkg);
            const relPath = binMap[name];
            if (!relPath) continue;
            const absPath = joinPaths(installedDir, relPath);
            if (fs.exists(absPath)) return absPath;
        }

        return null;
    }

    /**
     * Given a bin path (from node_modules/.bin or lock), try to extract the
     * real JS entry file from wrapper scripts.  Falls back to running the
     * bin through cmd.exe / sh if the wrapper can't be parsed.
     */
    private resolveEntry(binPath: string): ResolvedBin {
        const normPath = toPosixPath(binPath);
        const isNodeModulesBin = normPath.includes('/node_modules/.bin/');

        if (isNodeModulesBin) {
            if (this.isWin) {
                // Find the .cmd/.bat file
                let cmdPath: string | null = null;
                if (normPath.toLowerCase().endsWith('.cmd') || normPath.toLowerCase().endsWith('.bat')) {
                    cmdPath = binPath;
                } else {
                    for (const ext of WIN_BIN_EXTS) {
                        const c = binPath + ext;
                        if (fs.exists(c)) { cmdPath = c; break; }
                    }
                }
                if (cmdPath) {
                    const entry = resolveWinBinEntry(cmdPath);
                    if (entry) return { entry, binPath: cmdPath, fallback: false, reason: 'win-cmd-entry' };
                    // Can't parse the .cmd — fall back to cmd.exe
                    return { entry: cmdPath, binPath: cmdPath, fallback: true, reason: 'unparsed-win-cmd' };
                }
                // No .cmd/.bat found for this node_modules/.bin entry —
                // the extensionless file might be a raw JS script with a shebang
                const entry = resolveUnixBinEntry(binPath);
                if (entry) return { entry, binPath, fallback: false, reason: 'win-posix-shim-entry' };
            } else {
                // Unix: parse shebang / wrapper for real JS entry
                const entry = resolveUnixBinEntry(binPath);
                if (entry) return { entry, binPath, fallback: false, reason: 'unix-shim-entry' };
                // Wrapper couldn't be parsed — mark as fallback
                return { entry: binPath, binPath, fallback: true, reason: 'unparsed-unix-shim' };
            }
        }

        // Lock bin path (not in node_modules/.bin) — try to resolve JS entry
        // from the path itself (it might be a direct JS file)
        if (normPath.toLowerCase().endsWith('.js') || normPath.toLowerCase().endsWith('.mjs') || normPath.toLowerCase().endsWith('.cjs')) {
            return { entry: binPath, binPath, fallback: false, reason: 'direct-js' };
        }

        // Unknown — run as-is, likely will fallback to cmd.exe or chmod
        return { entry: binPath, binPath, fallback: true, reason: 'unknown-non-js' };
    }
}

function env(k: string): string | null {
    try { return os.getenv(k); } catch { return null; }
}

function resolveCacheDir(): string {
    const envDir = env('CTS_CACHE_DIR');
    if (envDir) return toPosixPath(envDir);
    const home = toPosixPath(String(os.homeDir || (isWindows ? env('USERPROFILE') : env('HOME')) || '/root'));
    return joinPaths(home, '.cts');
}

function findNearestPackageDir(start: string): string | null {
    let dir = toPosixPath(start);
    const root = pathRoot(dir);
    while (true) {
        const pkgPath = joinPaths(dir, 'package.json');
        if (fs.exists(pkgPath)) return dir;
        if (dir === root) break;
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

function findCachedPackageDir(cacheDir: string, pkgName: string, range: string): string | null {
    const npmDir = joinPaths(cacheDir, 'npm');
    const slash = pkgName.indexOf('/');
    const scoped = pkgName.startsWith('@') && slash !== -1;
    const baseDir = scoped ? joinPaths(npmDir, pkgName.slice(0, slash)) : npmDir;
    const leaf = scoped ? pkgName.slice(slash + 1) : pkgName;
    const exactDir = joinPaths(baseDir, `${leaf}@${range}`);
    if (fs.exists(joinPaths(exactDir, 'package.json'))) return exactDir;

    let entries: string[] = [];
    try { entries = fs.readdir(baseDir) as string[]; } catch { return null; }
    const prefix = `${leaf}@`;
    const versions = entries
        .filter((entry) => entry.startsWith(prefix) && fs.exists(joinPaths(baseDir, entry, 'package.json')))
        .map((entry) => entry.slice(prefix.length));
    if (!versions.length) return null;

    const resolved = matchLatestVersion(versions, range)
        ?? (versions.includes(range) ? range : null);
    if (!resolved) return null;

    const resolvedDir = joinPaths(baseDir, `${leaf}@${resolved}`);
    return fs.exists(joinPaths(resolvedDir, 'package.json')) ? resolvedDir : null;
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
        } else if (DENO_BOOL_FLAGS.has(flag)
                || /^--unstable(-|$)/.test(flag)   // all --unstable-* variants
                || /^--allow-/.test(flag)           // --allow-X not in the static list
                || /^--deny-/.test(flag)) {         // --deny-X not in the static list
            // Known deno-only flag — drop silently
        } else {
            // Unknown flag — pass through (might be cts flags like --silent)
            out.push(t);
        }
        i++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Environment variable expansion
// ---------------------------------------------------------------------------

/**
 * Expand $VAR and ${VAR} in a string using the given env.
 * $$ is escaped as a literal $ (shell convention).
 * $ followed by non-identifier characters (e.g. $/foo) is left as-is.
 */
function expandVars(s: string, env: Record<string, string>): string {
    return s.replace(/\$(\$|\{(\w+)\}|(\w+))/g, (_, esc, braced, bare) => {
        if (esc === '$') return '$';
        const name = braced || bare;
        if (!name) return _;
        return env[name] ?? '';
    });
}

// ---------------------------------------------------------------------------
// Command parsing and execution
// ---------------------------------------------------------------------------

/**
 * Execute a command string.
 * - `deno run [flags] <file> [args]` → re-invoke cts
 * - `deno task <name>` → re-invoke cts task
 * - Anything else → resolve each segment via BinResolver, fail if not found
 */
async function execCommand(
    cmd: string,
    env: Record<string, string>,
    cwd: string,
    extraArgs: string[],
    resolver: BinResolver,
): Promise<number> {
    // Expand environment variables in the command string before parsing
    const mergedEnv = { ...os.environ(), ...env };
    const expanded = expandVars(cmd, mergedEnv);

    const segments = parseShellCommand(expanded);
    if (!segments.length) return 0;

    // Single-command shortcuts
    if (segments.length === 1) {
        const seg = segments[0]!;
        if (!seg.bin) return 0;  // empty command after parsing
        const allArgs = [...seg.args, ...extraArgs];

        // deno run [flags] <file> [args]
        if (seg.bin === 'deno' && seg.args[0] === 'run') {
            const stripped = stripDenoRunFlags(seg.args.slice(1));
            if (!stripped.length) {
                console.error('[task] `deno run` with no entry file');
                return 1;
            }
            return execRun([...stripped, ...extraArgs], env, cwd);
        }

        // deno task <name>
        if (seg.bin === 'deno' && seg.args[0] === 'task') {
            return execTask([...seg.args.slice(1), ...extraArgs], env, cwd);
        }

        // Try resolve as bin
        const resolved = resolver.resolve(seg.bin, cwd);
        if (resolved) {
            return execBinary(resolved, allArgs, env, cwd);
        }

        console.error(`[task] Command '${seg.bin}' not found in bin index or node_modules/.bin`);
        return 1;
    }

    // Multi-segment pipeline: op is on the segment BEFORE the operator.
    // seg.op === '&&': run next only if this succeeds; bail on failure
    // seg.op === '||': run next only if this fails; skip next on success
    // seg.op === ';':  always run next regardless of exit code
    // seg.op === undefined (last seg / after '|'/'&'): bail on failure
    let prevCode = 0;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        const isLast = i === segments.length - 1;
        const segArgs = isLast ? [...seg.args, ...extraArgs] : seg.args;

        // Handle deno run/task in multi-segment too
        if (seg.bin === 'deno' && seg.args[0] === 'run') {
            const stripped = stripDenoRunFlags(seg.args.slice(1));
            if (!stripped.length) {
                console.error('[task] `deno run` with no entry file');
                prevCode = 1;
            } else {
                prevCode = await execRun(isLast ? [...stripped, ...extraArgs] : stripped, env, cwd);
            }
        } else if (seg.bin === 'deno' && seg.args[0] === 'task') {
            prevCode = await execTask(isLast ? [...seg.args.slice(1), ...extraArgs] : seg.args.slice(1), env, cwd);
        } else {
            const resolved = resolver.resolve(seg.bin, cwd);
            if (!resolved) {
                console.error(`[task] Command '${seg.bin}' not found in bin index or node_modules/.bin`);
                return 1;
            }
            prevCode = await execBinary(resolved, segArgs, env, cwd);
        }

        if (prevCode !== 0) {
            if (seg.op === ';') continue;   // ; — always run next
            if (seg.op === '||') continue;  // || — run next as fallback
            return prevCode;                // && or no op — bail
        } else {
            if (seg.op === '||') i++;       // || succeeded — skip the fallback segment
        }
    }
    return prevCode;
}

async function execRun(args: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const mergedEnv = { ...os.environ(), ...env };
    const child = process.spawn([os.exePath, 'run', ...args], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
        env: mergedEnv, cwd,
    });
    const info = await child.wait();
    return info.exit_status ?? 0;
}

async function execTask(args: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const mergedEnv = { ...os.environ(), ...env };
    const child = process.spawn([os.exePath, 'task', ...args], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
        env: mergedEnv, cwd,
    });
    const info = await child.wait();
    return info.exit_status ?? 0;
}

async function execBinary(resolved: ResolvedBin, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const mergedEnv = { ...os.environ(), ...env };
    const isWin = isWindows;

    log.debug('task', () => `exec bin: entry=${resolved.entry} binPath=${resolved.binPath} fallback=${resolved.fallback} reason=${resolved.reason ?? ''}`);

    if (resolved.fallback) {
        // Couldn't parse the wrapper script — fall back to cmd.exe / sh
        if (isWin || resolved.binPath.toLowerCase().endsWith('.cmd') || resolved.binPath.toLowerCase().endsWith('.bat')) {
            return rawExec(['cmd', '/c', resolved.binPath, ...args], mergedEnv, cwd);
        }
        // Unix fallback: make executable
        try { fs.chmod(resolved.binPath, 0o755); } catch {}
    }

    // Run the JS entry through the same CLI path as user files.
    return rawExec([os.exePath, 'run', resolved.entry, ...args], mergedEnv, cwd);
}

async function rawExec(argv: string[], env: Record<string, string>, cwd: string): Promise<number> {
    try {
        const mergedEnv = { ...os.environ(), ...env };
        const child = process.spawn(argv, {
            stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
            env: mergedEnv, cwd,
        });
        const info = await child.wait();
        return info.exit_status ?? 0;
    } catch (e) {
        console.error(`[task] Failed to spawn: ${argv.join(' ')}\n  ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}

// ---------------------------------------------------------------------------
// Task graph
// ---------------------------------------------------------------------------

export class TaskRunner {
    private readonly tasks: Record<string, TaskDef>;
    private readonly cwd: string;
    private readonly resolver: BinResolver;
    private readonly done = new Set<string>();
    private readonly running = new Set<string>();  // cycle detection

    constructor(tasks: Record<string, TaskDef>, cwd: string, lockStore: LockStore) {
        this.tasks = tasks;
        this.cwd   = cwd;
        this.resolver = new BinResolver(lockStore);
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

    has(name: string): boolean {
        return this.tasks[name] !== undefined;
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

        // Cycle detection
        if (this.running.has(name)) {
            console.error(`\x1b[31m✖ Circular dependency detected:\x1b[0m ${name}`);
            return 1;
        }

        const command = typeof def === 'string' ? def : def.command;
        const deps    = typeof def === 'string' ? [] : (def.dependencies ?? []);
        const env     = typeof def === 'string' ? {} : (def.env ?? {});

        // Validate: empty command string
        if (!command || !command.trim()) {
            console.error(`\x1b[31m✖ Task \x1b[36m${name}\x1b[0m\x1b[31m has an empty command\x1b[0m`);
            return 1;
        }

        // Run dependencies first (DFS, skip already-done)
        this.running.add(name);
        try {
            for (const dep of deps) {
                if (this.done.has(dep)) continue;
                const code = await this.run(dep);
                if (code !== 0) {
                    console.error(`\x1b[31m✖ Dependency task \x1b[36m${dep}\x1b[0m\x1b[31m failed (exit ${code})\x1b[0m`);
                    return code;
                }
            }
        } finally {
            this.running.delete(name);
        }

        if (this.done.has(name)) return 0;

        log.debug('task', () => `\n\x1b[32m$ ${command}\x1b[0m`);
        // Only pass extra args to the leaf task, not to dependencies
        const code = await execCommand(command, env, this.cwd, extraArgs, this.resolver);
        if (code === 0) this.done.add(name);
        if (code !== 0) console.error(`\x1b[31m✖ Task \x1b[36m${name}\x1b[0m\x1b[31m exited with code ${code}\x1b[0m`);
        return code;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Find and load the nearest deno.json/deno.jsonc or package.json containing tasks. */
export function loadTasks(startDir: string, lockStore: LockStore): { runner: TaskRunner; configPath: string } | null {
    let dir = toPosixPath(startDir);
    const isWin = isWindows;
    while (true) {
        // Collect tasks from both deno.json and package.json (deno.json takes priority)
        const merged: Record<string, TaskDef> = {};
        let found = false;
        let configPath = '';

        // package.json "scripts" — loaded first so deno.json can override
        const pkgP = joinPaths(dir, 'package.json');
        if (fs.exists(pkgP)) {
            try {
                const pkg = safeParse<{ scripts?: Record<string, string> }>(readText(pkgP));
                if (pkg?.scripts && typeof pkg.scripts === 'object') {
                    for (const [k, v] of Object.entries(pkg.scripts)) {
                        merged[k] = String(v);
                    }
                    found = true;
                    configPath = pkgP;
                }
            } catch (e) {
                log.warn('task', () => `Failed to parse ${pkgP}: ${errMsg(e)}`);
            }
        }

        // deno.json / deno.jsonc — overrides package.json on conflict
        for (const name of ['deno.json', 'deno.jsonc']) {
            const p = joinPaths(dir, name);
            if (!fs.exists(p)) continue;
            try {
                const cfg = safeParse<DenoConfig>(stripJsonc(readText(p)));
                if (cfg.tasks && typeof cfg.tasks === 'object') {
                    for (const [k, v] of Object.entries(cfg.tasks)) {
                        merged[k] = v;
                    }
                    found = true;
                    configPath = p;  // deno.json is the primary config
                }
            } catch (e) {
                log.warn('task', () => `Failed to parse ${p}: ${errMsg(e)}`);
            }
        }

        if (found) return { runner: new TaskRunner(merged, dir, lockStore), configPath };

        const up = dirname(dir);
        if (up === dir) break;
        // Windows: stop at drive root (e.g. "C:/")
        if (isWin && /^[A-Za-z]:\/?$/.test(dir) && up.length < dir.length) break;
        dir = up;
    }
    return null;
}
