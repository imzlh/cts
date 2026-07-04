// runtime/index.ts — TypeScriptRuntime (composition root)
//
// Owns the top-level object graph: resolver + compiler + resources.
// Installs engine hooks, manages precache lifecycle, loads entry/polyfill.

import { ModuleCompiler } from '../compile/index';
import { createConfig } from '../config';
import type { ScanResult } from '../deps';
import { DepScanner } from '../deps';
import { formatError } from '../errors';
import { tryLoadOxc, type OxcTranspiler } from '../oxc';
import { ParseDriver } from '../parse';
import { ModuleResolver } from '../resolve/index';
import { LockStore } from '../lock';
import { materializeNodeModules } from '../resolve/linker';
import { guessFileKind } from '../resolve/protocols/base';
import { parseShellCommand } from '../shell';
import { isRemote } from '../source/cache';
import type { FileKind, ModuleFormat, ModuleInfo, NodeBuiltinResolver, RuntimeConfig } from '../types';
import { PrecacheProgress, dirname, ensureDir, errMsg, isAbsolute, isWindows, joinPaths, log, normalizePath, cwd as posixCwd, resolveFile, toPosixPath, writeText } from '../utils';
import { installEngineHooks, type EngineHooks } from './hooks';
import { fillMeta } from './meta';
import { ResourceManager, createResourceManager } from './resources';

const os = import.meta.use('os');
const console = import.meta.use('console');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const process = import.meta.use('process');

const fs = import.meta.use('fs');

/** Nearest ancestor of `start` containing a project manifest, or undefined. */
function findProjectRoot(start: string): string | undefined {
    let cur = toPosixPath(start);
    for (;;) {
        for (const name of ['deno.json', 'deno.jsonc', 'package.json']) {
            try { if (fs.exists(joinPaths(cur, name))) return cur; } catch {}
        }
        const up = dirname(cur);
        if (up === cur) return undefined;
        cur = up;
    }
}

/**
 * Decide where cts.lock lives and whether we may write it. The lock is a
 * resolution cache, not something to scatter next to every script:
 *   - --lock-dir           → that dir (writable only when persisting)
 *   - cno cache (persist)  → project root, else the global cache dir
 *   - run/eval/repl/test   → read-only; reuse a project lock if present,
 *                            else the global cache dir (open if there, else
 *                            purely in-memory). Never writes to disk.
 */
function resolveLockTarget(cfg: RuntimeConfig, entryDir?: string): { dir: string; readOnly: boolean } {
    const persist = cfg.persistLock === true;
    if (cfg.lockDir) return { dir: cfg.lockDir, readOnly: !persist };

    const projectRoot = findProjectRoot(entryDir ?? os.cwd);
    if (persist) return { dir: projectRoot ?? cfg.cacheDir, readOnly: false };

    if (projectRoot && LockStore.existsAt(projectRoot)) return { dir: projectRoot, readOnly: true };
    return { dir: cfg.cacheDir, readOnly: true };
}

export class TypeScriptRuntime {
    readonly resolver: ModuleResolver;
    readonly compiler: ModuleCompiler;
    readonly config: RuntimeConfig;
    readonly resources: ResourceManager;
    private readonly initHooks: Array<(specPath: string, info: ModuleInfo) => void> = [];
    private readonly engineHooks: EngineHooks;
    private readonly oxc: OxcTranspiler | null;

    /** Register an additional callback to fire after each module's init hook. */
    addInitHook(fn: (specPath: string, info: ModuleInfo) => void): void {
        this.initHooks.push(fn);
    }

    constructor(cfg: RuntimeConfig, entryDir?: string) {
        this.config = cfg;
        this.resources = createResourceManager();

        // Lock location/mode: only `cno cache` persists to disk; run/eval/etc.
        // are read-only or in-memory, and never in the entry file's directory.
        if (cfg.disableLock) {
            this.resolver = new ModuleResolver(cfg, undefined, true);
        } else {
            const lock = resolveLockTarget(cfg, entryDir);
            this.resolver = new ModuleResolver(cfg, lock.dir, lock.readOnly);
        }

        this.compiler = new ModuleCompiler(this.resolver, cfg);

        this.oxc = cfg.enableOxc === false ? null : tryLoadOxc();
        if (this.oxc) this.compiler.setOxc(this.oxc);

        // Install engine hooks
        this.engineHooks = installEngineHooks(this.resolver, this.compiler, {
            onInitHook: (specPath, info) => {
                for (const fn of this.initHooks) {
                    try { fn(specPath, info); } catch { }
                }
            },
            onSyntaxError: (e) => this.reportSyntax(e),
        });

        this.hookEvents();

        // Register handler cache cleanup
        this.resources.register(() => this.resolver.clearHandlerCaches());
    }

    // -------------------------------------------------------------------------
    // Event hooks (unhandled rejections, job exceptions)
    // -------------------------------------------------------------------------

    private hookEvents(): void {
        const trace = new Set();
        engine.onEvent((name: number, data: any) => {
            const ET = engine.EventType;
            if (name === ET.UNHANDLED_REJECTION) {
                const r = data[1] as Error;
                if (trace.size > 20) trace.clear();
                else if (trace.has(r)) return false;
                trace.add(r);
                log.warn('runtime', formatError(r, 'unhandled promise rejection'));
                return false;
            }
            if (name === ET.JOB_EXCEPTION) {
                log.warn('runtime', formatError(data, 'unhandled job exception'));
                return true;
            }
            return false;
        });
    }

    // -------------------------------------------------------------------------
    // Pre-cache: async parallel BFS, then full resource cleanup
    // -------------------------------------------------------------------------

    async precache(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult> {
        return this.runPrecache((scanner) =>
            scanner.scan(entrySpecPath, entryLocalPath)
        , os.cwd);
    }

    async precacheFromSpecifiers(specifiers: string[], dir: string): Promise<ScanResult> {
        return this.runPrecache((scanner) =>
            scanner.scanFromSpecifiers(specifiers, dir)
        , dir);
    }

    async precacheEntryAndSpecifiers(entrySpecPath: string, entryLocalPath: string, specifiers: string[], dir: string): Promise<ScanResult> {
        return this.runPrecache((scanner) =>
            scanner.scanEntryAndSpecifiers(entrySpecPath, entryLocalPath, specifiers, dir)
        , dir);
    }

    private async runPrecache(
        scanFn: (scanner: DepScanner) => Promise<ScanResult>,
        projectDir: string,
    ): Promise<ScanResult> {
        const prog = this.config.silent ? null : new PrecacheProgress(6);
        const parseDriver = new ParseDriver(this.oxc);
        const scanner = new DepScanner(this.resolver, this.config, prog, this.oxc, parseDriver.scanFile.bind(parseDriver));
        log.debug('precache', () => `pipeline: scan=${this.oxc ? 'oxc+fallback' : 'fallback-only'}, transform=${this.oxc ? 'oxc+sucrase fallback' : 'sucrase-only'}`);

        let result: ScanResult;
        try {
            log.debug('deps', () => 'scan begin');
            const scanStarted = Date.now();
            result = await scanFn(scanner);
            log.debug('deps', () => `scan done in ${Date.now() - scanStarted}ms`);
        } catch (e) {
            try { this.resolver.rewriteLock(); } catch { }
            prog?.stop();
            this.resources.release();
            await parseDriver.terminate();
            throw e;
        }

        // The scan-phase spinner has nothing left to show once resolution
        // finishes, and its 200ms redraw loop would otherwise clobber the
        // scan-error lines below and deferred lifecycle scripts' own
        // console/child output (both print while the old timer was ticking).
        // Stopping here — not just at the very end — lets that output print
        // cleanly, and setCompileProgress() below restarts a fresh spinner
        // for precompile instead of redrawing stale scan-phase numbers.
        prog?.stop();

        for (const { spec, parent, error } of result.errors)
            log.warn('deps', () => `"${spec}" from "${parent}": ${error}`);
        log.debug('precache', () => `scan complete: ${result.modules.length} modules, ${result.errors.length} errors`);
        this.resolver.rewriteLock();

        if (this.config.nodeModulesMode !== 'normal') {
            const nodeModulesMode = this.config.nodeModulesMode;
            log.debug('precache', () => 'materialize node_modules begin');
            try {
                await materializeNodeModules(
                    result.edges,
                    nodeModulesMode,
                    this.config.cacheDir,
                    projectDir,
                    (done, total) => prog?.setLinkProgress(done, total),
                );
            } catch (e) {
                log.warn('precache', () => `node_modules materialization failed: ${errMsg(e)}`);
            }
            log.debug('precache', () => 'materialize node_modules end');
        }

        // Run deferred npm lifecycle scripts
        if (!this.config.ignoreScripts) {
            log.debug('precache', () => 'lifecycle scripts begin');
            await this.runLifecycleScripts();
            log.debug('precache', () => 'lifecycle scripts end');
        }

        const scannable = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
        const scannableModules = result.modules.filter(m => {
            const dot = m.localPath.lastIndexOf('.');
            return dot !== -1 && scannable.has(m.localPath.slice(dot));
        });
        const toCompile = scannableModules.filter(m => {
            const remote = isRemote(m.specPath);
            return !this.compiler.esm.jsc.hasFresh(m.localPath, remote);
        });

        if (toCompile.length > 0) {
            try {
                log.debug('precache', () => `precompile begin: ${toCompile.length}/${scannableModules.length} modules`);
                prog?.setCompileProgress(0, toCompile.length);
                const remoteSet = new Set<string>();
                for (const m of toCompile) if (isRemote(m.specPath)) remoteSet.add(m.localPath);
                // Stream each bytecode straight to disk and drop it — never hold
                // the whole graph's bytecode in memory (peak RSS bound).
                let written = 0;
                await parseDriver.compileModules(
                    toCompile,
                    (done, total) => prog?.setCompileProgress(done, total),
                    (localPath, bc) => {
                        this.compiler.esm.jsc.persistBytecode(localPath, bc, remoteSet.has(localPath));
                        written++;
                    },
                );
                log.debug('precache', () => `precompile end: ${written}/${toCompile.length} bytecodes`);
            } catch (e) {
                log.warn('precompile', () => `failed: ${errMsg(e)}`);
            }
        } else if (scannableModules.length > 0) {
            log.debug('precache', () => `precompile skipped: ${scannableModules.length} bytecodes fresh`);
        }

        log.debug('precache', () => 'worker terminate begin');
        await parseDriver.terminate();
        log.debug('precache', () => 'worker terminate end');
        prog?.stop();
        this.resources.release();
        return result;
    }

    private async runLifecycleScripts(): Promise<void> {
        const scripts = this.resolver.drainLifecycleScripts();
        if (!scripts.length) return;
        const isWin = isWindows;
        const shell = isWin ? 'cmd.exe' : 'sh';
        const shellArg = isWin ? '/c' : '-c';
        for (const { name, version, dir, lifecycle, script } of scripts) {
            log.debug('lifecycle', () => `${lifecycle} ${name}@${version}: ${script}`);
            if (!this.config.silent) {
                console.log(`  ${lifecycle}: ${name}@${version}`);
            }
            try {
                const argv = this.lifecycleArgv(script, shell, shellArg);
                const child = process.spawn(argv, {
                    cwd: dir,
                    stdin: 'inherit',
                    stdout: 'inherit',
                    stderr: 'inherit',
                    env: os.environ(),
                });
                const info = await child.wait();
                if (info.exit_status !== 0) {
                    log.warn('lifecycle', () => `${lifecycle} ${name}@${version} exited with code ${info.exit_status}`);
                }
            } catch (e) {
                log.warn('lifecycle', () => `${lifecycle} ${name}@${version} failed: ${errMsg(e)}`);
            }
        }
    }

    /**
     * A bare "node <file> [args]" lifecycle script — the overwhelming
     * majority of npm install/postinstall hooks (e.g. esbuild's install.js) — must
     * run through our own runtime rather than a system `node`: the npm cache
     * dir is a flat name@version layout, not a node_modules tree, so a real
     * Node.js can't resolve the package's own sibling optionalDependencies
     * (e.g. esbuild's platform binary packages) and fails with
     * "Cannot find module". Inline `node -e/--eval` hooks should become
     * `cno eval <code>`. Anything else keeps going through the shell as-is.
     */
    private lifecycleArgv(script: string, shell: string, shellArg: string): string[] {
        const segments = parseShellCommand(script);
        const seg = segments.length === 1 ? segments[0]! : null;
        if (seg && seg.bin === 'node' && !seg.op) {
            const [first, second] = seg.args;
            if (first === '-e' || first === '--eval') {
                if (second) return [os.exePath, 'eval', second];
                return [shell, shellArg, script];
            }
            if (first?.startsWith('--eval=')) {
                return [os.exePath, 'eval', first.slice('--eval='.length)];
            }
            return [os.exePath, 'run', ...seg.args];
        }
        return [shell, shellArg, script];
    }

    // -------------------------------------------------------------------------
    // Polyfill + entry
    // -------------------------------------------------------------------------

    async loadPolyfill(path: string): Promise<void> {
        const localPath = this.resolvePolyfillPath(path);
        const specPath = localPath;
        const info: ModuleInfo = {
            specPath,
            localPath,
            format: 'esm',
            fileKind: guessFileKind(localPath),
        };
        const meta: Record<string, any> = {};
        fillMeta(meta, info, this.resolver);
        meta.polyfill = true;
        await this.compiler.load(info, meta).eval();
        log.debug('runtime', () => `polyfill: ${specPath}`);
    }

    private resolvePolyfillPath(path: string): string {
        const normalized = toPosixPath(path);
        if (isAbsolute(normalized)) return resolveFile(normalizePath(normalized));
        return resolveFile(normalizePath(joinPaths(posixCwd(), normalized)));
    }

    async loadEntry(path: string, extra: Record<string, any> = {}, lang = 'ts'): Promise<CModuleEngine.Module> {
        const info = this.resolver.resolve(path, `${os.cwd}/<entry>`);
        const meta: Record<string, any> = { lang, ...extra };
        fillMeta(meta, info, this.resolver);
        meta.main = true;
        return this.compiler.load(info, meta);
    }

    loadSourceEntry(
        code: string,
        path: string,
        extra: Record<string, any> = {},
        opts: { lang?: string; format?: ModuleFormat; fileKind?: FileKind } = {},
    ): CModuleEngine.Module {
        this.resolver.entry = path;
        const info: ModuleInfo = {
            specPath: path,
            localPath: path,
            format: opts.format ?? 'esm',
            fileKind: opts.fileKind ?? 'source',
        };
        const meta: Record<string, any> = { lang: opts.lang ?? 'ts', ...extra };
        fillMeta(meta, info, this.resolver);
        meta.main = true;
        return this.compiler.loadSource(code, info, meta);
    }

    registerNodeResolver(r: NodeBuiltinResolver): void {
        this.resolver.registerNodeResolver(r);
    }

    flushLock(): void { this.resolver.flushLock(); }
    get rtConfig(): RuntimeConfig { return this.config; }

    /** Clean up runtime caches and loaded modules */
    cleanup(): void {
        if (this.compiler.hasPendingLoads()) {
            log.warn('runtime', () => 'cleanup() called while async loads are in-flight');
            return;
        }
        this.compiler.clearLoadedModules();
        this.engineHooks.clearLoadedModules();
        this.compiler.esm.jsc.clearMemory();
        this.resolver.clearRuntimeCaches();
        this.resolver.clearHandlerCaches();
    }

    private reportSyntax(e: SyntaxError): never {
        const cause = e.cause as { source?: SyntaxError; code?: string; path?: string } | undefined;
        if (!cause?.source || !cause.code || !cause.path) {
            log.debug('runtime', () => `reportSyntax: malformed cause, rethrowing`);
            throw e;
        }
        const { source, code, path } = cause;
        const hash = crypto.hexEncode(crypto.md5(engine.encodeString(path)));
        const logPath = `${this.config.cacheDir}/fail-${hash}.log`;
        ensureDir(dirname(logPath));
        writeText(logPath, [
            `cts SyntaxError (${new Date().toISOString()})`,
            `${source.name}: ${source.message}`, source.stack ?? '',
            '-'.repeat(50), `File: ${path}`,
            code.split('\n').map((l, i) => `${(i + 1).toString().padStart(4)} | ${l}`).join('\n'),
        ].join('\n'));
        throw new SyntaxError(`${source.message} (see ${logPath})`, { cause: e.cause });
    }
}

export function createRuntime(cfg: Partial<RuntimeConfig> = {}, entryDir?: string): TypeScriptRuntime {
    return new TypeScriptRuntime(createConfig(cfg), entryDir);
}
