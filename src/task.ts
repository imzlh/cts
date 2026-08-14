import { basename, dirname, joinPaths, normalizePath, pathRoot, toPosixPath, readText, stripJsonc, safeParse, errMsg, matchLatestVersion, latestVersion, compareVersions, log, findLocalBin, WIN_BIN_EXTS, isWindows, hashString, isValidNpmPackageName } from './utils';
import { parseShellCommand, requiresShellEvaluation, resolveWinBinEntry, resolveUnixBinEntry } from './shell';
import { expandArgv, expandRedirectTarget, parseTaskScript, type TaskCommand, type TaskPipeline } from './task-shell';
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
const engine = import.meta.use('engine');

const taskTerminalSignalNames = [
    'SIGINT', 'SIGQUIT', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
] as const;

interface TaskPackageMetadata {
    path: string;
    name?: string;
    version?: string;
    config?: unknown;
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

function nodeTaskArgv(args: string[], forwardedArgs: string[]): string[] {
    const first = args[0];
    if (first === undefined) return [os.exePath, ...forwardedArgs];
    if (first === '-e' || first === '--eval') {
        const source = args[1];
        if (source === undefined) return [os.exePath, ...forwardedArgs, 'eval'];
        return [os.exePath, ...forwardedArgs, 'eval', source, ...args.slice(2)];
    }
    if (first.startsWith('--eval=')) {
        return [os.exePath, ...forwardedArgs, 'eval', first.slice('--eval='.length), ...args.slice(1)];
    }
    if (first === '-p' || first === '--print') {
        const source = args[1];
        if (source === undefined) return [os.exePath, ...forwardedArgs, '--print'];
        return [os.exePath, ...forwardedArgs, '--print', source, ...args.slice(2)];
    }
    if (first === '-v' || first === '--version') return [os.exePath, '--version'];
    if (first === '-h' || first === '--help') return [os.exePath, '--help'];
    if (first === '--') return args.length > 1
        ? [os.exePath, ...forwardedArgs, 'run', ...args.slice(1)]
        : [os.exePath, ...forwardedArgs];
    // Keep node flags on cno instead of falling back to PATH.  The task
    // contract is that a `node` token is always the current runtime; an
    // unsupported flag may still be understood by cno (for example
    // --require/--inspect), and otherwise cno can report it directly.
    if (first.startsWith('-')) return [os.exePath, ...forwardedArgs, ...args];
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
    // Keep project bins before the inherited PATH, like npm.  `node` and `deno`
    // are rewritten from parsed task commands; they must not be emulated with
    // PATH links because the link's directory is also used by Windows DLL
    // search and can hide the runtime's native dependencies.
    let pathPrefix = '';
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

interface InternalTaskSession {
    cwd: string;
    env: Record<string, string>;
}

interface InternalCommandResult {
    code: number;
    stdout?: Uint8Array;
}

function taskOutput(bytes: Uint8Array, redirectFd?: number): void {
    if (bytes.byteLength === 0) return;
    fs.write(redirectFd ?? os.STDOUT_FILENO, bytes);
}

function taskRedirectPath(cwd: string, target: string): string {
    if (target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(target)) {
        return normalizePath(target);
    }
    return joinPaths(cwd, target);
}

function openTaskRedirect(command: TaskCommand, session: InternalTaskSession): number | undefined | null {
    if (!command.redirect) return undefined;
    const target = expandRedirectTarget(command.redirect, session.env);
    if (target === null) return null;
    const flags = fs.OPEN_WRONLY | fs.OPEN_CREAT |
        (command.redirect.op === '>>' ? fs.OPEN_APPEND : fs.OPEN_TRUNC);
    return fs.open(taskRedirectPath(session.cwd, target), flags, 0o666);
}

function splitTaskAssignments(argv: string[]): { assignments: Record<string, string>; argv: string[] } {
    const assignments: Record<string, string> = {};
    let index = 0;
    while (index < argv.length) {
        const word = argv[index] ?? '';
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
        if (!match) break;
        assignments[match[1] ?? ''] = match[2] ?? '';
        index++;
    }
    return { assignments, argv: argv.slice(index) };
}

function resolveInternalTaskArgv(
    argv: string[],
    resolver: BinResolver,
    session: InternalTaskSession,
    forwardedArgs: string[],
): string[] {
    const bin = argv[0] ?? '';
    const args = argv.slice(1);
    if (bin === 'node') return nodeTaskArgv(args, forwardedArgs);
    if (bin === 'deno' && args[0] === 'run') {
        const stripped = stripDenoRunFlags(args.slice(1));
        return [os.exePath, ...forwardedArgs, 'run', ...stripped];
    }
    if (bin === 'deno' && args[0] === 'task') {
        return [os.exePath, ...forwardedArgs, 'task', ...args.slice(1)];
    }
    // Other Deno subcommands (for example `deno serve`) are runtime CLI
    // commands too. Resolve the command name directly instead of letting the
    // child search PATH, where it could select a host Deno or a shim.
    if (bin === 'deno') return [os.exePath, ...forwardedArgs, ...args];
    const resolved = resolver.resolve(bin, session.cwd);
    if (!resolved) return argv;
    if (resolved.fallback) {
        return isWindows
            ? [env('ComSpec') ?? env('COMSPEC') ?? 'cmd.exe', '/d', '/s', '/c', resolved.binPath, ...args]
            : [resolved.binPath, ...args];
    }
    return [os.exePath, 'run', `--lock-dir=${session.cwd}`, resolved.entry, ...args];
}

function concatTaskChunks(chunks: Uint8Array[], total: number): Uint8Array {
    if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function readTaskPipe(pipe: CModuleProcess.Pipe): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const buffer = new Uint8Array(64 * 1024);
    let total = 0;
    for (;;) {
        const count = await pipe.read(buffer);
        if (count === 0) break;
        const chunk = buffer.slice(0, count);
        chunks.push(chunk);
        total += chunk.byteLength;
    }
    return concatTaskChunks(chunks, total);
}

function runInternalTaskBuiltin(
    argv: string[],
    session: InternalTaskSession,
): { code: number; output: Uint8Array } | null {
    const bin = argv[0];
    if (bin === 'true') return { code: 0, output: new Uint8Array(0) };
    if (bin === 'false') return { code: 1, output: new Uint8Array(0) };
    if (bin === 'exit') {
        const code = argv[1] === undefined ? 0 : Number(argv[1]);
        return { code: Number.isInteger(code) ? code & 0xff : 2, output: new Uint8Array(0) };
    }
    if (bin === 'pwd') return { code: 0, output: engine.encodeString(session.cwd + '\n') };
    if (bin === 'echo') {
        const noNewline = argv[1] === '-n';
        const start = noNewline ? 2 : 1;
        return { code: 0, output: engine.encodeString(argv.slice(start).join(' ') + (noNewline ? '' : '\n')) };
    }
    if (bin === 'cd') {
        const target = argv[1] ?? env('USERPROFILE') ?? env('HOMEPATH') ?? session.cwd;
        const next = taskRedirectPath(session.cwd, target);
        try {
            if (!fs.stat(next).isDirectory) return { code: 1, output: new Uint8Array(0) };
            session.cwd = next;
            session.env.PWD = next;
            return { code: 0, output: new Uint8Array(0) };
        } catch {
            return { code: 1, output: new Uint8Array(0) };
        }
    }
    if (bin === 'export') {
        for (const assignment of argv.slice(1)) {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(assignment);
            if (!match) return { code: 1, output: new Uint8Array(0) };
            session.env[match[1] ?? ''] = match[2] ?? session.env[match[1] ?? ''] ?? '';
        }
        return { code: 0, output: new Uint8Array(0) };
    }
    if (bin === 'unset') {
        for (const name of argv.slice(1)) delete session.env[name];
        return { code: 0, output: new Uint8Array(0) };
    }
    return null;
}

async function executeInternalTaskCommand(
    command: TaskCommand,
    input: Uint8Array | undefined,
    capture: boolean,
    session: InternalTaskSession,
    resolver: BinResolver,
    forwardedArgs: string[],
): Promise<InternalCommandResult> {
    const expanded = expandArgv(command, session.env);
    const { assignments, argv } = splitTaskAssignments(expanded);
    if (argv.length === 0) {
        Object.assign(session.env, assignments);
        return { code: 0, stdout: capture ? new Uint8Array(0) : undefined };
    }

    const redirectFd = openTaskRedirect(command, session);
    if (redirectFd === null) return { code: 1 };
    // A redirect consumes this command's stdout even when the command is an
    // intermediate pipeline stage.  In that case the next stage receives EOF;
    // there is no pipe-backed child.stdout to read.
    const captureOutput = capture && redirectFd === undefined;
    const builtin = runInternalTaskBuiltin(argv, session);
    if (builtin) {
        try {
            if (captureOutput) return { code: builtin.code, stdout: builtin.output };
            taskOutput(builtin.output, redirectFd);
            return { code: builtin.code, stdout: capture ? new Uint8Array(0) : undefined };
        } finally {
            if (redirectFd !== undefined) fs.close(redirectFd);
        }
    }

    const childEnv = { ...session.env, ...assignments };
    const concrete = resolveInternalTaskArgv(argv, resolver, session, forwardedArgs);
    try {
        const child = process.spawn(concrete, {
            stdin: input === undefined ? 'inherit' : 'pipe',
            stdout: captureOutput ? 'pipe' : redirectFd ?? 'inherit',
            stderr: 'inherit',
            env: childEnv,
            cwd: session.cwd,
        });
        const inputDone = input === undefined
            ? Promise.resolve()
            : child.stdin.write(input).then(() => child.stdin.shutdown());
        const output = captureOutput
            ? readTaskPipe(child.stdout)
            : Promise.resolve(capture ? new Uint8Array(0) : undefined);
        const [info, stdout] = await Promise.all([child.wait(), output, inputDone]).then(([info, stdout]) => [info, stdout] as const);
        return { code: taskExitCode(info), stdout };
    } catch (e) {
        console.error(`[task] Failed to spawn: ${concrete.join(' ')}\n  ${errMsg(e)}`);
        return { code: 1 };
    } finally {
        if (redirectFd !== undefined) fs.close(redirectFd);
    }
}

async function executeInternalTaskPipeline(
    pipeline: TaskPipeline,
    session: InternalTaskSession,
    resolver: BinResolver,
    forwardedArgs: string[],
): Promise<number> {
    let input: Uint8Array | undefined;
    let code = 0;
    for (let i = 0; i < pipeline.commands.length; i++) {
        const capture = i + 1 < pipeline.commands.length;
        const result = await executeInternalTaskCommand(
            pipeline.commands[i]!, input, capture, session, resolver, forwardedArgs,
        );
        code = result.code;
        input = result.stdout;
    }
    return code;
}

async function executeInternalTaskShell(
    pipelines: TaskPipeline[],
    envOverrides: Record<string, string>,
    cwd: string,
    resolver: BinResolver,
    forwardedArgs: string[],
): Promise<number> {
    const session: InternalTaskSession = {
        cwd,
        env: { ...os.environ(), ...taskShellEnv(envOverrides, cwd), PWD: cwd },
    };
    let code = 0;
    let previousOp: TaskPipeline['op'];
    for (const pipeline of pipelines) {
        const shouldRun = previousOp === undefined || previousOp === ';'
            || (previousOp === '&&' && code === 0)
            || (previousOp === '||' && code !== 0);
        if (shouldRun) code = await executeInternalTaskPipeline(pipeline, session, resolver, forwardedArgs);
        previousOp = pipeline.op;
    }
    return code;
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
    const fullScript = shellCommand(cmd, extraArgs);
    if (isWindows) {
        const internal = parseTaskScript(fullScript);
        if (internal) return executeInternalTaskShell(internal, env, cwd, resolver, forwardedArgs);
    }
    const segments = parseShellCommand(cmd);
    if (!segments.length) return 0;
    if (requiresShellEvaluation(cmd) || hasShellOnlySyntax(segments)) {
        return rawExec(taskShellArgv(fullScript), taskShellEnv(env, cwd), cwd);
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

        if (seg.bin === 'deno') {
            return rawExec([os.exePath, ...forwardedArgs, ...allArgs], taskShellEnv(env, cwd), cwd);
        }

        if (seg.bin === 'node') {
            const argv = nodeTaskArgv(allArgs, forwardedArgs);
            return rawExec(argv, taskShellEnv(env, cwd), cwd);
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
        } else if (seg.bin === 'deno') {
            prevCode = await rawExec([os.exePath, ...forwardedArgs, ...segArgs], taskShellEnv(env, cwd), cwd);
        } else if (seg.bin === 'node') {
            const argv = nodeTaskArgv(segArgs, forwardedArgs);
            prevCode = await rawExec(argv, taskShellEnv(env, cwd), cwd);
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
