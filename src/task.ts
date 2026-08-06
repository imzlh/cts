import { basename, dirname, joinPaths, normalizePath, pathRoot, toPosixPath, readText, stripJsonc, safeParse, errMsg, matchLatestVersion, latestVersion, compareVersions, log, findLocalBin, WIN_BIN_EXTS, isWindows, hashString, ensureDir, isValidNpmPackageName } from './utils';
import { parseShellCommand, requiresShellEvaluation, resolveWinBinEntry, resolveUnixBinEntry } from './shell';
import { LockStore } from './lock';
import { getBinMap, getLookupBinMap, readPkgFresh, resolvePackageBinPath } from './resolve/pkg';
import { createConfig } from './config';
import { NpmHandler } from './resolve/protocols/npm';
import { runAsync } from './flow';

const os = import.meta.use('os');
const console = import.meta.use('console');
const fs = import.meta.use('fs');
const process = import.meta.use('process');
const signals = import.meta.use('signals');

const taskTerminalSignalNames = [
    'SIGINT', 'SIGQUIT', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
] as const;

interface TaskPackageMetadata {
    path: string;
    name?: string;
    version?: string;
    config?: unknown;
}

// Shell syntax can hide runtime commands behind assignments, `env`, or a
// nested shell.  A process-local PATH shim keeps those on cno as well.
let taskRuntimeShimDir: string | null | undefined;

function ensureTaskRuntimeShim(): string | null {
    if (taskRuntimeShimDir !== undefined) return taskRuntimeShimDir;
    taskRuntimeShimDir = null;
    try {
        const dir = joinPaths(toPosixPath(os.tmpDir), `cno-task-bin-${os.pid}`);
        ensureDir(dir);
        const names = isWindows ? ['node.exe', 'deno.exe'] : ['node', 'deno'];
        let complete = true;
        for (const name of names) {
            const link = joinPaths(dir, name);
            try { fs.unlink(link); } catch { /* fresh or stale */ }
            try {
                if (isWindows) fs.symlink(os.exePath, link, 'file');
                else fs.symlink(os.exePath, link);
            } catch {
                try { fs.link(os.exePath, link); } catch { /* checked below */ }
            }
            if (!fs.exists(link)) complete = false;
        }
        if (complete) taskRuntimeShimDir = dir;
    } catch {
        // Direct node/deno rewriting still works if the temp directory is unavailable.
    }
    return taskRuntimeShimDir;
}

// deno.json task schema

type TaskDef = string | {
    command: string;
    description?: string;
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

// Bin resolver — resolves command names to executable paths

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

    /** Bin → JS entry; opts.global uses only ~/.cts/npm (no cwd). */
    resolve(name: string, cwd: string, opts?: { global?: boolean }): ResolvedBin | null {
        if (name.startsWith('npm:')) return this.resolveNpmSpecifierBin(name);
        if (name.startsWith('/') || name.startsWith('.') || !isSafeBinCommandName(name)) return null;
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
        const binMap = getLookupBinMap(pkg);
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

    npmPackageSpecifier(name: string): string | null {
        if (!name.startsWith('npm:') &&
            (name.startsWith('/') || name.startsWith('.') || !isSafeBinCommandName(name) || name.startsWith('-'))) {
            return null;
        }
        const parsed = parseNpmExecSpec(name);
        if (!parsed) return null;
        return `npm:${parsed.name}@${parsed.version}`;
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

        const binMap = getLookupBinMap(pkg);
        const binName = parsed.binName ?? defaultBinName(pkg.name ?? parsed.name, binMap);
        if (!binName) return null;

        const relPath = binMap[binName];
        if (!relPath) return null;

        const absPath = resolvePackageBinPath(installedDir, relPath);
        return absPath ? this.resolveEntry(absPath) : null;
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
        const absPath = resolvePackageBinPath(dir, relPath);
        if (absPath) matches.push({ version: String(pkg.version ?? '0.0.0'), path: absPath });
    }

    /** Unwrap .cmd/sh bin to JS entry; else run via shell. */
    private resolveEntry(binPath: string): ResolvedBin {
        // Symlinked bins (soft store / node_modules/.bin → ~/.cts/npm/…) must
        // resolve relative requires against the real package dir, not the link.
        let realBin = toPosixPath(binPath);
        try {
            if (fs.exists(binPath)) realBin = toPosixPath(fs.realpath(binPath));
        } catch { /* keep original */ }
        const isNodeModulesBin = toPosixPath(binPath).includes('/node_modules/.bin/');

        if (isNodeModulesBin) {
            if (this.isWin) {
                // Find the .cmd/.bat file
                let cmdPath: string | null = null;
                if (realBin.toLowerCase().endsWith('.cmd') || realBin.toLowerCase().endsWith('.bat')) {
                    cmdPath = binPath;
                } else {
                    for (const ext of WIN_BIN_EXTS) {
                        const c = binPath + ext;
                        if (fs.exists(c)) { cmdPath = c; break; }
                    }
                }
                if (cmdPath) {
                    const entry = resolveWinBinEntry(cmdPath);
                    if (entry) return { entry: realpathQuiet(entry), binPath: cmdPath, fallback: false, reason: 'win-cmd-entry' };
                    // Can't parse the .cmd — fall back to cmd.exe
                    return { entry: cmdPath, binPath: cmdPath, fallback: true, reason: 'unparsed-win-cmd' };
                }
                // No .cmd/.bat found for this node_modules/.bin entry —
                // the extensionless file might be a raw JS script with a shebang
                const entry = resolveUnixBinEntry(binPath);
                if (entry) return { entry: realpathQuiet(entry), binPath, fallback: false, reason: 'win-posix-shim-entry' };
            } else {
                // Unix: parse shebang / wrapper for real JS entry
                const entry = resolveUnixBinEntry(binPath);
                if (entry) return { entry: realpathQuiet(entry), binPath, fallback: false, reason: 'unix-shim-entry' };
                // Direct symlink to package bin (no wrapper text) — use realpath.
                if (realBin.toLowerCase().endsWith('.js') || realBin.toLowerCase().endsWith('.mjs') || realBin.toLowerCase().endsWith('.cjs')) {
                    return { entry: realBin, binPath, fallback: false, reason: 'unix-symlink-js' };
                }
                // Wrapper couldn't be parsed — mark as fallback
                return { entry: binPath, binPath, fallback: true, reason: 'unparsed-unix-shim' };
            }
        }

        // Lock/cache bin path (not in node_modules/.bin) — try to resolve JS entry
        // from the path itself (it might be a direct JS file or node shebang).
        if (realBin.toLowerCase().endsWith('.js') || realBin.toLowerCase().endsWith('.mjs') || realBin.toLowerCase().endsWith('.cjs')) {
            return { entry: realBin, binPath, fallback: false, reason: 'direct-js' };
        }
        // Extensionless `#!/usr/bin/env node` scripts (typescript/bin/tsc, tape/bin/tape)
        // are the norm for store bins. Windows cannot exec them, and the fallback below
        // hands them to `cmd /c`, which reports "is not recognized as an internal or
        // external command". Shebang parsing is pure text work, so run it on every
        // platform — the node_modules/.bin branch above already does (see 'win-posix-shim-entry').
        const entry = resolveUnixBinEntry(binPath);
        if (entry) return { entry: realpathQuiet(entry), binPath, fallback: false, reason: 'direct-node-shebang' };

        // Unknown — run as-is, likely will fallback to cmd.exe or chmod
        return { entry: realBin, binPath, fallback: true, reason: 'unknown-non-js' };
    }
}

function realpathQuiet(path: string): string {
    try {
        if (fs.exists(path)) return toPosixPath(fs.realpath(path));
    } catch { /* keep original */ }
    return toPosixPath(path);
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

    if (!name || !version || binName === '' || !isValidNpmPackageName(name) ||
        version.includes('\\') || version.includes('\0') || version.includes(':') ||
        (binName !== undefined && !isNpmSpecBinName(binName))) return null;
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

/**
 * A bare command name typed by the user (`cno exec foo`). It is looked up on the
 * filesystem via findLocalBin()/lock index, so path-ish characters are rejected.
 */
function isSafeBinCommandName(name: string): boolean {
    return !!name && name !== '.' && name !== '..' && !name.includes('/') &&
        !name.includes('\\') && !name.includes('\0') && !name.includes(':');
}

/**
 * The `<bin>` half of `npm:pkg@ver/<bin>`. Unlike a bare command name this is
 * only ever a key looked up in the package's own bin map, never a path, so a
 * literal '\' or '"' is legal — npm permits such keys and the
 * @denotest/special-chars-in-bin-name fixture declares `\foo"`. '/' stays
 * rejected because it would mean a subpath, and ':' because it collides with
 * specifier scheme parsing.
 */
function isNpmSpecBinName(name: string): boolean {
    return !!name && name !== '.' && name !== '..' && !name.includes('/') &&
        !name.includes('\0') && !name.includes(':');
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

/** URL/github pins — same class as npm isOpaqueVersionRange (no semver). */
function isOpaqueTaskRange(range: string): boolean {
    if (/^https?:\/\//i.test(range) || range.startsWith('github:')) return true;
    if (/^(?:git\+)?https:\/\/github\.com\//i.test(range)) return true;
    return false;
}

/** Warm pin written by NpmHandler for opaque URL/github installs. */
function readUrlRangePin(npmDir: string, name: string, url: string): string | null {
    try {
        const path = joinPaths(npmDir, '.url-pins', `${hashString(`${name}\0${url}`)}.txt`);
        const text = readText(path).trim();
        return text || null;
    } catch {
        return null;
    }
}

function findCachedPackageDir(cacheDir: string, pkgName: string, range: string): string | null {
    const npmDir = joinPaths(cacheDir, 'npm');
    const slash = pkgName.indexOf('/');
    const scoped = pkgName.startsWith('@') && slash !== -1;
    const baseDir = scoped ? joinPaths(npmDir, pkgName.slice(0, slash)) : npmDir;
    const leaf = scoped ? pkgName.slice(slash + 1) : pkgName;
    // Opaque: only pin / exact store tag — never semver against a URL string.
    if (isOpaqueTaskRange(range)) {
        const pinned = readUrlRangePin(npmDir, pkgName, range);
        if (pinned) {
            const pinnedDir = joinPaths(baseDir, `${leaf}@${pinned}`);
            if (fs.exists(joinPaths(pinnedDir, 'package.json'))) return pinnedDir;
        }
        return null;
    }

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
        const relPath = getLookupBinMap(cachedPkg)[binName];
        if (!relPath) continue;
        const absPath = resolvePackageBinPath(installedDir, relPath);
        if (absPath) return absPath;
    }
    return null;
}

// All deno-specific flags that have no cts equivalent are dropped.

// Flags that consume the next token as a value (mandatory value)
const DENO_VALUE_FLAGS = new Set([
    '--config', '-c', '--import-map',
    '--cert', '--seed', '--v8-flags',
    '--location', '--log-level', '--watch-exclude',
]);

// Optional-value flags: only strip the inline `=value`, never a following token.
const DENO_OPTIONAL_VALUE_FLAGS = new Set([
    '--reload', '-r', '--inspect', '--inspect-brk', '--inspect-wait',
    '--node-modules-dir', '--vendor', '--env-file', '--lock',
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
    '--quiet', '-q', '--watch', '--lock-write',
    '--frozen',
]);

/** After `deno run`: [entry, ...args] with deno flags stripped. */
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
        } else if (DENO_OPTIONAL_VALUE_FLAGS.has(flag)) {
            // Optional value — only strip inline `=value`; never consume next token.
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

function nodeTaskArgv(args: string[], forwardedArgs: string[]): string[] | null {
    const first = args[0];
    if (first === undefined) return [os.exePath, ...forwardedArgs];
    if (first === '-e' || first === '--eval') {
        const source = args[1];
        if (source === undefined) return null;
        return [os.exePath, ...forwardedArgs, 'eval', source, ...args.slice(2)];
    }
    if (first.startsWith('--eval=')) {
        return [os.exePath, ...forwardedArgs, 'eval', first.slice('--eval='.length), ...args.slice(1)];
    }
    if (first === '-p' || first === '--print') {
        const source = args[1];
        if (source === undefined) return null;
        return [os.exePath, ...forwardedArgs, '--print', source, ...args.slice(2)];
    }
    if (first === '-v' || first === '--version') return [os.exePath, '--version'];
    if (first === '-h' || first === '--help') return [os.exePath, '--help'];
    if (first === '--') return args.length > 1
        ? [os.exePath, ...forwardedArgs, 'run', ...args.slice(1)]
        : [os.exePath, ...forwardedArgs];
    if (first.startsWith('-')) return null;
    return [os.exePath, ...forwardedArgs, 'run', ...args];
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

export function taskShellEnv(env: Record<string, string>, cwd: string): Record<string, string> {
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
    // Keep runtime aliases before project bins, then walk up like npm for tools.
    let pathPrefix = ensureTaskRuntimeShim() ?? '';
    let dir = toPosixPath(cwd);
    const root = pathRoot(dir);
    while (true) {
        const bin = joinPaths(dir, 'node_modules', '.bin');
        pathPrefix = pathPrefix ? `${pathPrefix}${sep}${bin}` : bin;
        if (dir === root) break;
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    const current = merged[pathKey] ?? '';
    return { ...env, PWD: cwd, [pathKey]: current ? `${pathPrefix}${sep}${current}` : pathPrefix };
}

export function taskShellArgv(script: string): string[] {
    if (isWindows) return [env('ComSpec') ?? env('COMSPEC') ?? 'cmd.exe', '/c', script];
    // Keep the foreground shell alive until the leaf decides whether a
    // terminal signal was handled or should become exit 128 + signal.
    const signalNumbers = availableTaskSignalNumbers(taskTerminalSignalNames);
    const trapSignals = signalNumbers.length ? signalNumbers.join(' ') : 'INT QUIT TSTP';
    const runtime = quoteShellArg(os.exePath);
    return ['sh', '-c', `trap ':' ${trapSignals}\nnode() { ${runtime} "$@"; }\ndeno() { ${runtime} "$@"; }\n${script}`];
}

function availableTaskSignalNumbers(
    names: readonly string[],
): number[] {
    if (!signals) return [];
    const numbers = new Set<number>();
    for (const name of names) {
        const signalNumber = signals.signals[name];
        if (typeof signalNumber === 'number') numbers.add(signalNumber);
    }
    return [...numbers];
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

/** Run command string: deno run/task → cts; shell ops → shell; else BinResolver. */
async function execCommand(
    cmd: string,
    env: Record<string, string>,
    cwd: string,
    extraArgs: string[],
    resolver: BinResolver,
    forwardedArgs: string[] = [],
): Promise<number> {
    const segments = parseShellCommand(cmd);
    if (!segments.length) return 0;
    if (requiresShellEvaluation(cmd) || hasShellOnlySyntax(segments)) {
        const script = shellCommand(cmd, extraArgs);
        return rawExec(taskShellArgv(script), taskShellEnv(env, cwd), cwd);
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

        if (seg.bin === 'node') {
            const argv = nodeTaskArgv(allArgs, forwardedArgs);
            if (argv) return rawExec(argv, taskShellEnv(env, cwd), cwd);
        }

        const resolved = resolver.resolve(seg.bin, cwd);
        if (resolved) {
            return execBinary(resolved, allArgs, env, cwd);
        }

        return rawExec(taskShellArgv(shellCommand(cmd, extraArgs)), taskShellEnv(env, cwd), cwd);
    }

    // Pipeline: && / || / ; on previous segment (unsupported ops already rejected).
    let prevCode = 0;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) break;
        if (i > 0) {
            const previousOp = segments[i - 1]?.op;
            const shouldRun = previousOp === ';' ||
                (previousOp === '&&' && prevCode === 0) ||
                (previousOp === '||' && prevCode !== 0);
            if (!shouldRun) continue;
        }
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
        } else if (seg.bin === 'node') {
            const argv = nodeTaskArgv(segArgs, forwardedArgs);
            prevCode = argv
                ? await rawExec(argv, taskShellEnv(env, cwd), cwd)
                : await rawExec(taskShellArgv(segmentCommand(seg.bin, segArgs)), taskShellEnv(env, cwd), cwd);
        } else {
            const resolved = resolver.resolve(seg.bin, cwd);
            if (!resolved) {
                prevCode = await rawExec(taskShellArgv(segmentCommand(seg.bin, segArgs)), taskShellEnv(env, cwd), cwd);
            } else {
                prevCode = await execBinary(resolved, segArgs, env, cwd);
            }
        }

    }
    return prevCode;
}

async function execRun(args: string[], env: Record<string, string>, cwd: string, forwardedArgs: string[] = []): Promise<number> {
    const mergedEnv = { ...os.environ(), ...taskShellEnv(env, cwd), PWD: cwd };
    return runTaskChild([os.exePath, ...forwardedArgs, 'run', ...args], mergedEnv, cwd);
}

async function execTask(args: string[], env: Record<string, string>, cwd: string, forwardedArgs: string[] = []): Promise<number> {
    const mergedEnv = { ...os.environ(), ...taskShellEnv(env, cwd), PWD: cwd };
    return runTaskChild([os.exePath, ...forwardedArgs, 'task', ...args], mergedEnv, cwd);
}

function chmodExecutableQuietly(path: string): void {
    try {
        fs.chmod(path, 0o755);
    } catch {
        // Fallback execution will surface real permission errors.
    }
}

async function execBinary(resolved: ResolvedBin, args: string[], env: Record<string, string>, cwd: string): Promise<number> {
    // Nested tools (npm-run-all → vue-tsc) resolve via PATH; keep .bin first.
    const pathEnv = taskShellEnv(env, cwd);
    const mergedEnv = { ...os.environ(), ...pathEnv, PWD: cwd };
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
        return await runTaskChild(argv, mergedEnv, cwd);
    } catch (e) {
        console.error(`[task] Failed to spawn: ${argv.join(' ')}\n  ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}

function appendPackageConfigEnv(out: Record<string, string>, key: string, value: unknown): void {
    if (value === null || value === undefined) {
        out[key] = '';
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) appendPackageConfigEnv(out, `${key}_${i}`, value[i]);
        return;
    }
    if (typeof value === 'object') {
        for (const [child, childValue] of Object.entries(value as Record<string, unknown>)) {
            appendPackageConfigEnv(out, `${key}_${child}`, childValue);
        }
        return;
    }
    out[key] = String(value);
}

function packageTaskEnv(metadata: TaskPackageMetadata, name: string, command: string): Record<string, string> {
    const out: Record<string, string> = {
        npm_command: 'run-script',
        npm_execpath: os.exePath,
        npm_node_execpath: os.exePath,
        npm_lifecycle_event: name,
        npm_lifecycle_script: command,
        npm_package_json: metadata.path,
    };
    if (metadata.name !== undefined) out.npm_package_name = metadata.name;
    if (metadata.version !== undefined) out.npm_package_version = metadata.version;
    if (metadata.config !== undefined) appendPackageConfigEnv(out, 'npm_package_config', metadata.config);
    // Deno preserves an inherited user agent; provide a stable cno marker when absent.
    const inherited = os.environ().npm_config_user_agent;
    if (inherited === undefined) {
        let platform = 'unknown';
        let machine = 'unknown';
        try {
            const info = os.uname();
            platform = String(info.sysname).toLowerCase();
            machine = String(info.machine);
        } catch { /* keep conservative fallback */ }
        out.npm_config_user_agent = `cno/? npm/? cno/? ${platform} ${machine}`;
    }
    return out;
}

function taskExitCode(info: CModuleProcess.ExitInfo): number {
    if (info.term_signal === null) return info.exit_status;
    const signalNumber = signals?.signals[info.term_signal];
    return typeof signalNumber === 'number' ? 128 + signalNumber : 1;
}

export async function runTaskChild(
    argv: string[],
    env: Record<string, string>,
    cwd: string,
): Promise<number> {
    const signalGuards: CModuleSignals.SignalHandler[] = [];
    try {
        if (signals) {
            for (const signalNumber of availableTaskSignalNumbers(taskTerminalSignalNames)) {
                try {
                    signalGuards.push(signals.signal(signalNumber, () => {}));
                } catch {}
            }
        }
    } catch {}

    try {
        const child = process.spawn(argv, {
            stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
            env, cwd,
        });
        return taskExitCode(await child.wait());
    } finally {
        for (const guard of signalGuards) {
            try { guard.close(); } catch {}
        }
    }
}

export class TaskRunner {
    private readonly tasks: Record<string, TaskDef>;
    private readonly cwd: string;
    private readonly initCwd: string;
    private readonly resolver: BinResolver;
    private readonly forwardedArgs: string[];
    private readonly taskSources: Record<string, TaskSource>;
    private readonly packageMetadata?: TaskPackageMetadata;
    private readonly done = new Set<string>();
    private readonly running = new Set<string>();  // cycle detection

    constructor(tasks: Record<string, TaskDef>, cwd: string, lockStore: LockStore, options?: { forwardedArgs?: string[]; taskSources?: Record<string, TaskSource>; initCwd?: string; packageMetadata?: TaskPackageMetadata }) {
        this.tasks = tasks;
        this.cwd   = cwd;
        this.initCwd = options?.initCwd ?? cwd;
        this.resolver = new BinResolver(lockStore);
        this.forwardedArgs = options?.forwardedArgs ?? [];
        this.taskSources = options?.taskSources ?? {};
        this.packageMetadata = options?.packageMetadata;
    }

    list(): void {
        const names = Object.keys(this.tasks);
        if (!names.length) {
            console.log('  \x1b[2mNo tasks defined in this config.\x1b[0m');
            return;
        }
        // Deno-style: name, optional // description lines, then indented command.
        console.log('Available tasks:');
        for (const name of names) {
            const def = this.tasks[name];
            if (!def) continue;
            const cmd = typeof def === 'string' ? def : def.command;
            const desc = typeof def === 'string' ? undefined : def.description;
            console.log(`- ${name}`);
            if (desc) {
                for (const line of String(desc).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
                    if (line.length === 0) continue;
                    console.log(`    // ${line}`);
                }
            }
            console.log(`    ${cmd}`);
        }
    }

    has(name: string): boolean {
        return this.tasks[name] !== undefined;
    }

    /** Exact name or Deno-style task globs (`*` → `.*`, anchored). */
    matchNames(pattern: string): string[] {
        if (!pattern.includes('*')) {
            return this.tasks[pattern] !== undefined ? [pattern] : [];
        }
        let escaped = '';
        for (let i = 0; i < pattern.length; i++) {
            const ch = pattern[i]!;
            if (ch === '*') escaped += '.*';
            else if (/[.+?^${}()|[\]\\]/.test(ch)) escaped += `\\${ch}`;
            else escaped += ch;
        }
        const re = new RegExp(`^${escaped}$`);
        const matched: string[] = [];
        for (const name of Object.keys(this.tasks)) {
            if (re.test(name)) matched.push(name);
        }
        return matched;
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
            ...(this.taskSources[name] === 'package' && this.packageMetadata
                ? packageTaskEnv(this.packageMetadata, name, command)
                : {}),
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

    /** Ad-hoc shell for `cno task --eval <script>` (specs/task/eval). */
    async runEval(script: string, extraArgs: string[] = []): Promise<number> {
        if (!script || !String(script).trim()) {
            console.error('error: [TASK] must be specified when using --eval');
            return 1;
        }
        const inheritedInitCwd = os.environ().INIT_CWD;
        const env = { INIT_CWD: inheritedInitCwd ?? this.initCwd };
        console.log(`Task  ${script}`);
        return execCommand(script, env, this.cwd, extraArgs, this.resolver, this.forwardedArgs);
    }
}

function taskRunnerForConfig(
    configPath: string,
    startDir: string,
    lockStore: LockStore,
    options: LoadTasksOptions,
): { runner: TaskRunner; configPath: string } | null {
    if (!fs.exists(configPath)) return null;
    const merged: Record<string, TaskDef> = {};
    const taskSources: Record<string, TaskSource> = {};
    let packageMetadata: TaskPackageMetadata | undefined;
    try {
        const base = basename(configPath);
        if (base === 'package.json') {
            const pkg = safeParse<{ name?: unknown; version?: unknown; config?: unknown; scripts?: Record<string, string> }>(readText(configPath));
            if (pkg) {
                packageMetadata = {
                    path: toPosixPath(configPath),
                    name: pkg.name === undefined ? undefined : String(pkg.name),
                    version: pkg.version === undefined ? undefined : String(pkg.version),
                    config: pkg.config,
                };
            }
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
    return { runner: new TaskRunner(merged, runCwd, lockStore, { ...options, initCwd, taskSources, packageMetadata }), configPath };
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
        let packageMetadata: TaskPackageMetadata | undefined;
        let found = false;
        let configPath = '';

        // package.json "scripts" — loaded first so deno.json can override
        const pkgP = joinPaths(dir, 'package.json');
        if (fs.exists(pkgP)) {
            try {
                const pkg = safeParse<{ name?: unknown; version?: unknown; config?: unknown; scripts?: Record<string, string> }>(readText(pkgP));
                if (pkg) {
                    packageMetadata = {
                        path: toPosixPath(pkgP),
                        name: pkg.name === undefined ? undefined : String(pkg.name),
                        version: pkg.version === undefined ? undefined : String(pkg.version),
                        config: pkg.config,
                    };
                }
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
                    packageMetadata,
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
