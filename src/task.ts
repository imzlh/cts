import { basename, dirname, joinPaths, normalizePath, pathRoot, toPosixPath, readText, stripJsonc, safeParse, errMsg, matchLatestVersion, latestVersion, compareVersions, log, findLocalBin, WIN_BIN_EXTS, isWindows } from './utils';
import { parseShellCommand, resolveWinBinEntry, resolveUnixBinEntry } from './shell';
import { LockStore } from './lock';
import { getBinMap, readPkgFresh } from './resolve/pkg';
import { createConfig } from './config';
import { NpmHandler } from './resolve/protocols/npm';
import { runAsync } from './flow';

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

type TaskSource = 'package' | 'deno';

interface DenoConfig {
    tasks?: Record<string, TaskDef>;
}

interface LoadTasksOptions {
    forwardedArgs?: string[];
    configPath?: string;
    runCwd?: string;
    initCwd?: string;
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
    private readonly cacheDir?: string;

    constructor(private lockStore: LockStore, opts: { cacheDir?: string } = {}) {
        this.isWin = isWindows;
        this.cacheDir = opts.cacheDir;
    }

    /**
     * Resolve a binary name to a runnable JS entry path.
     * Priority: local node_modules/.bin > lock bin index.
     * Returns null if name looks like a path or flag, or if the binary cannot be found.
     *
     * When possible, parses .cmd/.bat/shell wrappers to extract the real JS
     * entry so it can be run directly by the cts runtime.
     *
     * `opts.global` (used by `cno exec`) skips all cwd-scoped lookups (local
     * node_modules/.bin, this project's lock bin index, this project's
     * package.json deps) and resolves purely against the shared `~/.cts/npm`
     * cache, the same as an explicit `npm:<name>` spec — pnpm-dlx/pnpx style,
     * independent of which directory you run it from.
     */
    resolve(name: string, cwd: string, opts?: { global?: boolean }): ResolvedBin | null {
        if (name.startsWith('npm:')) return this.resolveNpmSpecifierBin(name);
        if (name.startsWith('/') || name.startsWith('.') || name.includes('/')) return null;
        if (name.startsWith('-')) return null;

        if (opts?.global) {
            return this.resolveNpmSpecifierBin(`npm:${name}`)
                ?? this.resolveCachedGlobalBin(name);
        }

        // 1. Local node_modules/.bin
        const local = findLocalBin(name, cwd);
        if (local) return this.resolveEntry(local);

        // 2. Lock bin index
        const lockBin = this.resolveLockBin(name);
        if (lockBin) return lockBin;

        // 3. Cache fallback from direct project deps/devDeps when node_modules is absent.
        const cached = this.resolveCachedProjectBin(name, cwd);
        if (cached) return this.resolveEntry(cached);

        return null;
    }

    explain(name: string): string | null {
        const parsed = parseNpmExecSpec(name);
        if (!parsed) return `Invalid npm executable specifier '${name}'.`;

        const cacheDir = resolveCacheDir(this.cacheDir);
        const installedDir = findCachedPackageDir(cacheDir, parsed.name, parsed.version);
        if (!installedDir) {
            return `Package '${parsed.name}@${parsed.version}' was not found in the CTS cache. ` +
                `cno exec only uses '${cacheDir}/npm'.`;
        }

        const pkg = readPkgFresh(installedDir);
        if (!pkg) return `Package '${parsed.name}' is cached, but its package.json could not be read.`;
        const binMap = getBinMap(pkg);
        const bins = Object.keys(binMap);
        const version = String(pkg.version ?? parsed.version);
        if (!bins.length) {
            return `Package '${pkg.name ?? parsed.name}@${version}' has no executable entry. use cno run for a source file or add a bin entry.`;
        }
        if (parsed.binName && !binMap[parsed.binName]) {
            return `Package '${pkg.name ?? parsed.name}@${version}' does not expose bin '${parsed.binName}'. ` +
                `Available bins: ${bins.join(', ')}.`;
        }
        if (!parsed.binName && !defaultBinName(pkg.name ?? parsed.name, binMap)) {
            return `Package '${pkg.name ?? parsed.name}@${version}' exposes multiple bins: ${bins.join(', ')}. ` +
                'Specify one as npm:<package>/<bin>.';
        }
        return `Package '${pkg.name ?? parsed.name}@${version}' declares a bin, but its target file is missing from the CTS cache.`;
    }

    private resolveLockBin(name: string): ResolvedBin | null {
        const lockBin = this.lockStore.getBin(name);
        return lockBin ? this.resolveEntry(lockBin.path) : null;
    }

    private resolveNpmSpecifierBin(spec: string): ResolvedBin | null {
        const parsed = parseNpmExecSpec(spec);
        if (!parsed) return null;

        const installedDir = findCachedPackageDir(resolveCacheDir(this.cacheDir), parsed.name, parsed.version);
        if (!installedDir) return null;

        const pkg = readPkgFresh(installedDir);
        if (!pkg) return null;

        const binMap = getBinMap(pkg);
        const binName = parsed.binName ?? defaultBinName(pkg.name ?? parsed.name, binMap);
        if (!binName) return null;

        const relPath = binMap[binName];
        if (!relPath) return null;

        const absPath = normalizePath(joinPaths(installedDir, relPath));
        return fs.exists(absPath) ? this.resolveEntry(absPath) : null;
    }

    private resolveCachedProjectBin(name: string, cwd: string): string | null {
        const pkgDir = findNearestPackageDir(cwd);
        if (!pkgDir) return null;
        const pkg = readPkgFresh(pkgDir);
        if (!pkg) return null;

        // Prefer a direct package-name match first, then scan the rest for custom bin names.
        const cacheDir = resolveCacheDir(this.cacheDir);
        return findCachedBinInDeps(name, cacheDir, pkg.dependencies, true)
            ?? findCachedBinInDeps(name, cacheDir, pkg.devDependencies, true)
            ?? findCachedBinInDeps(name, cacheDir, pkg.optionalDependencies, true)
            ?? findCachedBinInDeps(name, cacheDir, pkg.dependencies, false)
            ?? findCachedBinInDeps(name, cacheDir, pkg.devDependencies, false)
            ?? findCachedBinInDeps(name, cacheDir, pkg.optionalDependencies, false);
    }

    private resolveCachedGlobalBin(name: string): ResolvedBin | null {
        const npmDir = joinPaths(resolveCacheDir(this.cacheDir), 'npm');
        let entries: string[] = [];
        try {
            entries = fs.readdir(npmDir);
        } catch {
            return null;
        }

        const matches: Array<{ version: string; path: string }> = [];
        for (const entry of entries) {
            if (entry.startsWith('@')) {
                let scoped: string[] = [];
                try {
                    scoped = fs.readdir(joinPaths(npmDir, entry));
                } catch {
                    continue;
                }
                for (const child of scoped) this.collectCachedBinMatch(name, joinPaths(npmDir, entry, child), matches);
            } else {
                this.collectCachedBinMatch(name, joinPaths(npmDir, entry), matches);
            }
        }
        if (!matches.length) return null;
        matches.sort((a, b) => compareVersions(a.version, b.version));
        return this.resolveEntry(matches[matches.length - 1]!.path);
    }

    private collectCachedBinMatch(name: string, dir: string, matches: Array<{ version: string; path: string }>): void {
        const pkg = readPkgFresh(dir);
        if (!pkg) return;
        const relPath = getBinMap(pkg)[name];
        if (!relPath) return;
        const absPath = normalizePath(joinPaths(dir, relPath));
        if (fs.exists(absPath)) matches.push({ version: String(pkg.version ?? '0.0.0'), path: absPath });
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

        // Lock/cache bin path (not in node_modules/.bin) — try to resolve JS entry
        // from the path itself (it might be a direct JS file or node shebang).
        if (normPath.toLowerCase().endsWith('.js') || normPath.toLowerCase().endsWith('.mjs') || normPath.toLowerCase().endsWith('.cjs')) {
            return { entry: binPath, binPath, fallback: false, reason: 'direct-js' };
        }
        if (!this.isWin) {
            const entry = resolveUnixBinEntry(binPath);
            if (entry) return { entry, binPath, fallback: false, reason: 'direct-node-shebang' };
        }

        // Unknown — run as-is, likely will fallback to cmd.exe or chmod
        return { entry: binPath, binPath, fallback: true, reason: 'unknown-non-js' };
    }
}

function env(k: string): string | null {
    try {
        return os.getenv(k) ?? null;
    } catch {
        return null;
    }
}

interface NpmExecSpec {
    name: string;
    version: string;
    binName?: string;
}

function parseNpmExecSpec(raw: string): NpmExecSpec | null {
    let rest = raw.startsWith('npm:') ? raw.slice(4) : raw;
    while (rest.startsWith('/')) rest = rest.slice(1);
    if (!rest) return null;

    let name = '';
    let version = 'latest';
    let binName: string | undefined;

    if (rest.startsWith('@')) {
        const slash = rest.indexOf('/');
        if (slash <= 1) return null;
        const scope = rest.slice(0, slash);
        const tail = rest.slice(slash + 1);
        const at = tail.indexOf('@');
        const slash2 = tail.indexOf('/');
        if (at !== -1 && (slash2 === -1 || at < slash2)) {
            name = `${scope}/${tail.slice(0, at)}`;
            const after = tail.slice(at + 1);
            const slash3 = after.indexOf('/');
            version = slash3 === -1 ? after : after.slice(0, slash3);
            binName = slash3 === -1 ? undefined : after.slice(slash3 + 1);
        } else if (slash2 !== -1) {
            name = `${scope}/${tail.slice(0, slash2)}`;
            binName = tail.slice(slash2 + 1);
        } else {
            name = `${scope}/${tail}`;
        }
    } else {
        const at = rest.indexOf('@');
        const slash = rest.indexOf('/');
        if (at !== -1 && (slash === -1 || at < slash)) {
            name = rest.slice(0, at);
            const after = rest.slice(at + 1);
            const slash2 = after.indexOf('/');
            version = slash2 === -1 ? after : after.slice(0, slash2);
            binName = slash2 === -1 ? undefined : after.slice(slash2 + 1);
        } else if (slash !== -1) {
            name = rest.slice(0, slash);
            binName = rest.slice(slash + 1);
        } else {
            name = rest;
        }
    }

    if (!name || !version || binName === '') return null;
    return { name, version, binName };
}

function defaultBinName(pkgName: string, binMap: Record<string, string>): string | null {
    if (pkgName && binMap[pkgName]) return pkgName;
    const base = basename(pkgName);
    if (binMap[base]) return base;
    let onlyName: string | null = null;
    for (const name in binMap) {
        if (onlyName !== null) return null;
        onlyName = name;
    }
    return onlyName;
}

function resolveCacheDir(override?: string): string {
    if (override) return toPosixPath(override);
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
    try {
        entries = fs.readdir(baseDir);
    } catch {
        return null;
    }
    const prefix = `${leaf}@`;
    const versions: string[] = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry !== undefined &&
            entry.startsWith(prefix) &&
            fs.exists(joinPaths(baseDir, entry, 'package.json'))) {
            versions.push(entry.slice(prefix.length));
        }
    }
    if (!versions.length) return null;

    const resolved = (!range || range === 'latest' || range === '*')
        ? latestVersion(versions)
        : matchLatestVersion(versions, range) ?? (versions.includes(range) ? range : null);
    if (!resolved) return null;

    const resolvedDir = joinPaths(baseDir, `${leaf}@${resolved}`);
    return fs.exists(joinPaths(resolvedDir, 'package.json')) ? resolvedDir : null;
}

function findCachedBinInDeps(
    binName: string,
    cacheDir: string,
    deps: Record<string, string> | undefined,
    directOnly: boolean,
): string | null {
    if (!deps) return null;
    for (const pkgName in deps) {
        if (directOnly !== (pkgName === binName)) continue;
        const range = deps[pkgName];
        if (typeof range !== 'string' || !range) continue;
        const installedDir = findCachedPackageDir(cacheDir, pkgName, range);
        if (!installedDir) continue;
        const cachedPkg = readPkgFresh(installedDir);
        if (!cachedPkg) continue;
        const relPath = getBinMap(cachedPkg)[binName];
        if (!relPath) continue;
        const absPath = normalizePath(joinPaths(installedDir, relPath));
        if (fs.exists(absPath)) return absPath;
    }
    return null;
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
        const t = tokens[i];
        if (t === undefined) break;
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

function isDirectTaskOperator(op: string | undefined): boolean {
    return op === '&&' || op === '||' || op === ';';
}

function hasShellOnlySyntax(segments: ReturnType<typeof parseShellCommand>): boolean {
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) continue;
        if (seg.op && !isDirectTaskOperator(seg.op)) return true;
        if (i === segments.length - 1 && seg.op && seg.op !== ';') return true;

        const tokens = [seg.bin, ...seg.args];
        if (seg.bin.includes('=')) return true;
        if (tokens.some((token) => token.includes('<') || token.includes('>'))) return true;
    }
    return false;
}

function quoteShellArg(arg: string): string {
    if (!arg) return isWindows ? '""' : "''";
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
    if (isWindows) return `"${arg.replace(/(["^%])/g, '^$1')}"`;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function shellCommand(script: string, extraArgs: string[]): string {
    if (!extraArgs.length) return script;
    return `${script} ${joinQuotedArgs(extraArgs)}`;
}

function shellEnv(env: Record<string, string>, cwd: string): Record<string, string> {
    const merged = { ...os.environ(), ...env };
    let pathKey = 'PATH';
    if (isWindows) {
        pathKey = 'Path';
        for (const key in merged) {
            if (key.toLowerCase() === 'path') {
                pathKey = key;
                break;
            }
        }
    }
    const sep = isWindows ? ';' : ':';
    const localBin = joinPaths(cwd, 'node_modules', '.bin');
    const current = merged[pathKey] ?? '';
    return { ...env, PWD: cwd, [pathKey]: current ? `${localBin}${sep}${current}` : localBin };
}

function shellArgv(script: string): string[] {
    return isWindows ? ['cmd.exe', '/c', script] : ['sh', '-c', script];
}

function joinQuotedArgs(args: string[]): string {
    let out = '';
    for (let i = 0; i < args.length; i++) {
        if (i > 0) out += ' ';
        out += quoteShellArg(args[i] ?? '');
    }
    return out;
}

function segmentCommand(bin: string, args: string[]): string {
    if (!args.length) return quoteShellArg(bin);
    return `${quoteShellArg(bin)} ${joinQuotedArgs(args)}`;
}

// ---------------------------------------------------------------------------
// Command parsing and execution
// ---------------------------------------------------------------------------

/**
 * Execute a command string.
 * - `deno run [flags] <file> [args]` → re-invoke cts
 * - `deno task <name>` → re-invoke cts task
 * - Shell-only syntax → run through the platform shell
 * - Plain commands → resolve each segment via BinResolver, fail if not found
 */
async function execCommand(
    cmd: string,
    env: Record<string, string>,
    cwd: string,
    extraArgs: string[],
    resolver: BinResolver,
    forwardedArgs: string[] = [],
): Promise<number> {
    // Expand environment variables in the command string before parsing
    const mergedEnv = { ...os.environ(), ...env };
    const expanded = expandVars(cmd, mergedEnv);

    const segments = parseShellCommand(expanded);
    if (!segments.length) return 0;
    if (hasShellOnlySyntax(segments)) {
        const script = shellCommand(expanded, extraArgs);
        return rawExec(shellArgv(script), shellEnv(env, cwd), cwd);
    }

    // Single-command shortcuts
    if (segments.length === 1) {
        const seg = segments[0];
        if (!seg) return 0;
        if (!seg.bin) return 0;  // empty command after parsing
        const allArgs = [...seg.args, ...extraArgs];

        // deno run [flags] <file> [args]
        if (seg.bin === 'deno' && seg.args[0] === 'run') {
            const stripped = stripDenoRunFlags(seg.args.slice(1));
            if (!stripped.length) {
                console.error('[task] `deno run` with no entry file');
                return 1;
            }
            return execRun([...stripped, ...extraArgs], env, cwd, forwardedArgs);
        }

        // deno task <name>
        if (seg.bin === 'deno' && seg.args[0] === 'task') {
            return execTask([...seg.args.slice(1), ...extraArgs], env, cwd, forwardedArgs);
        }

        // Try resolve as bin
        const resolved = resolver.resolve(seg.bin, cwd);
        if (resolved) {
            return execBinary(resolved, allArgs, env, cwd);
        }

        return rawExec(shellArgv(shellCommand(expanded, extraArgs)), shellEnv(env, cwd), cwd);
    }

    // Multi-segment pipeline: op is on the segment BEFORE the operator.
    // seg.op === '&&': run next only if this succeeds; bail on failure
    // seg.op === '||': run next only if this fails; skip next on success
    // seg.op === ';':  always run next regardless of exit code
    // seg.op === undefined: last segment; unsupported shell ops handled above
    let prevCode = 0;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) break;
        const isLast = i === segments.length - 1;
        const segArgs = isLast ? [...seg.args, ...extraArgs] : seg.args;

        // Handle deno run/task in multi-segment too
        if (seg.bin === 'deno' && seg.args[0] === 'run') {
            const stripped = stripDenoRunFlags(seg.args.slice(1));
            if (!stripped.length) {
                console.error('[task] `deno run` with no entry file');
                prevCode = 1;
            } else {
                prevCode = await execRun(isLast ? [...stripped, ...extraArgs] : stripped, env, cwd, forwardedArgs);
            }
        } else if (seg.bin === 'deno' && seg.args[0] === 'task') {
            prevCode = await execTask(isLast ? [...seg.args.slice(1), ...extraArgs] : seg.args.slice(1), env, cwd, forwardedArgs);
        } else {
            const resolved = resolver.resolve(seg.bin, cwd);
            if (!resolved) {
                prevCode = await rawExec(shellArgv(segmentCommand(seg.bin, segArgs)), shellEnv(env, cwd), cwd);
            } else {
                prevCode = await execBinary(resolved, segArgs, env, cwd);
            }
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

async function execRun(args: string[], env: Record<string, string>, cwd: string, forwardedArgs: string[] = []): Promise<number> {
    const mergedEnv = { ...os.environ(), ...env, PWD: cwd };
    const child = process.spawn([os.exePath, ...forwardedArgs, 'run', ...args], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
        env: mergedEnv, cwd,
    });
    const info = await child.wait();
    return info.exit_status ?? 0;
}

async function execTask(args: string[], env: Record<string, string>, cwd: string, forwardedArgs: string[] = []): Promise<number> {
    const mergedEnv = { ...os.environ(), ...env, PWD: cwd };
    const child = process.spawn([os.exePath, ...forwardedArgs, 'task', ...args], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
        env: mergedEnv, cwd,
    });
    const info = await child.wait();
    return info.exit_status ?? 0;
}

function chmodExecutableQuietly(path: string): void {
    try {
        fs.chmod(path, 0o755);
    } catch {
        // Fallback execution will surface real permission errors.
    }
}

async function execBinary(resolved: ResolvedBin, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
    const mergedEnv = { ...os.environ(), ...env, PWD: cwd };
    const isWin = isWindows;

    log.debug('task', () => `exec bin: entry=${resolved.entry} binPath=${resolved.binPath} fallback=${resolved.fallback} reason=${resolved.reason ?? ''}`);

    if (resolved.fallback) {
        // Couldn't parse the wrapper script — fall back to cmd.exe / sh
        if (isWin || resolved.binPath.toLowerCase().endsWith('.cmd') || resolved.binPath.toLowerCase().endsWith('.bat')) {
            return rawExec(['cmd', '/c', resolved.binPath, ...args], mergedEnv, cwd);
        }
        // Unix fallback: make executable
        chmodExecutableQuietly(resolved.binPath);
        return rawExec([resolved.binPath, ...args], mergedEnv, cwd);
    }

    // Run the JS entry through the same CLI path as user files.
    return rawExec([os.exePath, 'run', `--lock-dir=${cwd}`, resolved.entry, ...args], mergedEnv, cwd);
}

async function rawExec(argv: string[], env: Record<string, string>, cwd: string): Promise<number> {
    try {
        const mergedEnv = { ...os.environ(), ...env, PWD: cwd };
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
    private readonly initCwd: string;
    private readonly resolver: BinResolver;
    private readonly forwardedArgs: string[];
    private readonly taskSources: Record<string, TaskSource>;
    private readonly done = new Set<string>();
    private readonly running = new Set<string>();  // cycle detection

    constructor(tasks: Record<string, TaskDef>, cwd: string, lockStore: LockStore, options?: { forwardedArgs?: string[]; taskSources?: Record<string, TaskSource>; initCwd?: string }) {
        this.tasks = tasks;
        this.cwd   = cwd;
        this.initCwd = options?.initCwd ?? cwd;
        this.resolver = new BinResolver(lockStore);
        this.forwardedArgs = options?.forwardedArgs ?? [];
        this.taskSources = options?.taskSources ?? {};
    }

    list(): void {
        const names = Object.keys(this.tasks);
        if (!names.length) {
            console.log('  \x1b[2mNo tasks defined in this config.\x1b[0m');
            return;
        }
        const maxLen = names.reduce((m, n) => Math.max(m, n.length), 0);
        for (const name of names) {
            const def = this.tasks[name];
            if (!def) continue;
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

    async run(name: string, extraArgs: string[] = [], includeLifecycle = true): Promise<number> {
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
        const inheritedInitCwd = os.environ().INIT_CWD;
        const env     = {
            INIT_CWD: inheritedInitCwd ?? this.initCwd,
            ...(typeof def === 'string' ? {} : (def.env ?? {})),
        };

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

        if (includeLifecycle && this.taskSources[name] === 'package') {
            const preName = `pre${name}`;
            if (this.tasks[preName] !== undefined) {
                const preCode = await this.run(preName, [], false);
                if (preCode !== 0) return preCode;
            }
        }

        log.debug('task', () => `\n\x1b[32m$ ${command}\x1b[0m`);
        // Only pass extra args to the leaf task, not to dependencies
        const code = await execCommand(command, env, this.cwd, extraArgs, this.resolver, this.forwardedArgs);
        if (code === 0) this.done.add(name);
        if (code !== 0) console.error(`\x1b[31m✖ Task \x1b[36m${name}\x1b[0m\x1b[31m exited with code ${code}\x1b[0m`);
        if (code !== 0) return code;

        if (includeLifecycle && this.taskSources[name] === 'package') {
            const postName = `post${name}`;
            if (this.tasks[postName] !== undefined) {
                return await this.run(postName, [], false);
            }
        }

        return 0;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function taskRunnerForConfig(
    configPath: string,
    startDir: string,
    lockStore: LockStore,
    options: LoadTasksOptions,
): { runner: TaskRunner; configPath: string } | null {
    if (!fs.exists(configPath)) return null;
    const merged: Record<string, TaskDef> = {};
    const taskSources: Record<string, TaskSource> = {};
    try {
        const base = basename(configPath);
        if (base === 'package.json') {
            const pkg = safeParse<{ scripts?: Record<string, string> }>(readText(configPath));
            for (const [k, v] of Object.entries(pkg?.scripts ?? {})) {
                merged[k] = String(v);
                taskSources[k] = 'package';
            }
        } else {
            const cfg = safeParse<DenoConfig>(stripJsonc(readText(configPath)));
            for (const [k, v] of Object.entries(cfg.tasks ?? {})) {
                merged[k] = v;
                taskSources[k] = 'deno';
            }
        }
    } catch (e) {
        log.warn('task', () => `Failed to parse ${configPath}: ${errMsg(e)}`);
        return null;
    }
    if (!Object.keys(merged).length) return null;
    const configDir = dirname(configPath);
    const runCwd = options.runCwd ?? configDir;
    const initCwd = options.initCwd ?? toPosixPath(startDir);
    return { runner: new TaskRunner(merged, runCwd, lockStore, { ...options, initCwd, taskSources }), configPath };
}

/** Find and load the nearest deno.json/deno.jsonc or package.json containing tasks. */
export function loadTasks(startDir: string, lockStore: LockStore, options: LoadTasksOptions = {}): { runner: TaskRunner; configPath: string } | null {
    if (options.configPath) {
        return taskRunnerForConfig(toPosixPath(options.configPath), startDir, lockStore, options);
    }
    let dir = toPosixPath(startDir);
    const isWin = isWindows;
    while (true) {
        // Collect tasks from both deno.json and package.json (deno.json takes priority)
        const merged: Record<string, TaskDef> = {};
        const taskSources: Record<string, TaskSource> = {};
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
                        taskSources[k] = 'package';
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
                        taskSources[k] = 'deno';
                    }
                    found = true;
                    configPath = p;  // deno.json is the primary config
                }
            } catch (e) {
                log.warn('task', () => `Failed to parse ${p}: ${errMsg(e)}`);
            }
        }

        if (found) {
            return {
                runner: new TaskRunner(merged, options.runCwd ?? dir, lockStore, {
                    ...options,
                    initCwd: options.initCwd ?? toPosixPath(startDir),
                    taskSources,
                }),
                configPath,
            };
        }

        const up = dirname(dir);
        if (up === dir) break;
        // Windows: stop at drive root (e.g. "C:/")
        if (isWin && /^[A-Za-z]:\/?$/.test(dir) && up.length < dir.length) break;
        dir = up;
    }
    return null;
}
