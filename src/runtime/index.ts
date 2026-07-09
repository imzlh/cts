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
import { isRemote } from '../source/cache';
import type { FileKind, ModuleFormat, ModuleInfo, NodeBuiltinResolver, RuntimeConfig } from '../types';
import { PrecacheProgress, clearNegativeCache, dirname, ensureDir, errMsg, isAbsolute, isWindows, joinPaths, log, normalizePath, cwd as posixCwd, pathRoot, resolveFile, toPosixPath, writeText } from '../utils';
import { installEngineHooks, type EngineHooks } from './hooks';
import { planLifecycleScript, resolveLifecycleCommandArgv, runLifecyclePlan, type LifecycleCommand } from './lifecycle';
import { fillMeta } from './meta';
import { ResourceManager, createResourceManager } from './resources';

const os = import.meta.use('os');
const console = import.meta.use('console');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const process = import.meta.use('process');
const worker = import.meta.use('worker');

const fs = import.meta.use('fs');

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isWebWorkerRuntime(): boolean {
    const data = worker.workerData;
    return !!worker.isWorker
        && !!worker.pipe
        && isRecord(data)
        && typeof data.__cts_entry === 'string'
        && !('__node_workerData' in data);
}

function isNodeWorkerRuntime(): boolean {
    const data = worker.workerData;
    return !!worker.isWorker
        && !!worker.pipe
        && isRecord(data)
        && '__node_workerData' in data;
}

function runtimeErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function postNodeWorkerError(error: unknown): boolean {
    if (!isNodeWorkerRuntime()) return false;
    const pipe = worker.pipe;
    if (!pipe) return false;
    pipe.postMessage({ __cno_node_worker_error__: runtimeErrorInfo(error) });
    return true;
}

function runtimeErrorInfo(error: unknown): { name: string; message: string; stack?: string } {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: typeof error.stack === 'string' ? error.stack : undefined,
        };
    }
    return { name: 'Error', message: String(error) };
}

function envPathKey(env: Record<string, string>): string {
    if (!isWindows) return 'PATH';
    for (const key in env) {
        if (key.toLowerCase() === 'path') return key;
    }
    return 'Path';
}

function lifecyclePathValue(cwd: string, existing: string, sep: string): string {
    let value = '';
    let dir = toPosixPath(cwd);
    const root = pathRoot(dir);
    while (true) {
        if (value) value += sep;
        value += joinPaths(dir, 'node_modules', '.bin');
        if (dir === root) break;
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return existing ? `${value}${sep}${existing}` : value;
}

function isPrecompilePath(filename: string): boolean {
    const length = filename.length;
    if (length < 3) return false;
    const last = filename.charCodeAt(length - 1);
    if (last === 115) {
        const prev = filename.charCodeAt(length - 2);
        if (prev === 116) return filename.charCodeAt(length - 3) === 46;
        if (prev !== 106) return false;
        const third = filename.charCodeAt(length - 3);
        return third === 46 ||
            (length >= 4 &&
                (third === 109 || third === 99) &&
                filename.charCodeAt(length - 4) === 46);
    }
    if (last !== 120 || length < 4) return false;
    const prev = filename.charCodeAt(length - 2);
    if (prev !== 115) return false;
    const third = filename.charCodeAt(length - 3);
    return (third === 116 || third === 106) &&
        filename.charCodeAt(length - 4) === 46;
}

function lifecycleEnv(cwd: string): Record<string, string> {
    const env = os.environ();
    const key = envPathKey(env);
    const sep = isWindows ? ';' : ':';
    env[key] = lifecyclePathValue(cwd, env[key] ?? '', sep);
    return env;
}

async function drainPipe(pipe: CModuleProcess.Pipe | null): Promise<void> {
    if (!pipe) return;
    const buf = new Uint8Array(64 * 1024);
    for (;;) {
        const n = await pipe.read(buf);
        if (n === 0) return;
    }
}

/** Nearest ancestor of `start` containing a project manifest, or undefined. */
function findProjectRoot(start: string): string | undefined {
    let cur = toPosixPath(start);
    for (;;) {
        for (const name of ['deno.json', 'deno.jsonc', 'package.json']) {
            try {
                if (fs.exists(joinPaths(cur, name))) return cur;
            } catch {}
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
                    try {
                        fn(specPath, info);
                    } catch { }
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
        const trace = new Set<unknown>();
        engine.onEvent((name: number, data: unknown) => {
            const ET = engine.EventType;
            if (name === ET.UNHANDLED_REJECTION) {
                const r = Array.isArray(data) ? data[1] : data;
                if (postNodeWorkerError(r)) return false;
                if (isWebWorkerRuntime()) {
                    const pipe = worker.pipe;
                    if (pipe) {
                        pipe.postMessage({
                            __cno_role: 'error',
                            message: runtimeErrorMessage(r),
                            error: runtimeErrorInfo(r),
                            filename: '',
                            lineno: 0,
                            colno: 0,
                        });
                        return false;
                    }
                }
                if (trace.size > 20) trace.clear();
                else if (trace.has(r)) return false;
                trace.add(r);
                log.warn('runtime', formatError(r, 'unhandled promise rejection'));
                return false;
            }
            if (name === ET.JOB_EXCEPTION) {
                if (postNodeWorkerError(data)) return true;
                if (isWebWorkerRuntime()) {
                    const pipe = worker.pipe;
                    if (pipe) {
                        pipe.postMessage({
                            __cno_role: 'error',
                            message: runtimeErrorMessage(data),
                            error: runtimeErrorInfo(data),
                            filename: '',
                            lineno: 0,
                            colno: 0,
                        });
                        return true;
                    }
                }
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
            try {
                this.resolver.rewriteLock();
            } catch { }
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
                prog?.clearForOutput();
                log.warn('precache', () => `node_modules materialization failed: ${errMsg(e)}`);
            }
            prog?.stop();
            log.debug('precache', () => 'materialize node_modules end');
        }

        // Run deferred npm lifecycle scripts
        if (!this.config.ignoreScripts) {
            log.debug('precache', () => 'lifecycle scripts begin');
            try {
                const count = await this.runLifecycleScripts(prog);
                if (count > 0 && result.errors.length > 0) {
                    clearNegativeCache();
                    await this.retryScanErrors(result);
                }
            } catch (e) {
                prog?.stop();
                this.resources.release();
                await parseDriver.terminate();
                throw e;
            }
            log.debug('precache', () => 'lifecycle scripts end');
        }

        let softNpmErrors = 0;
        const fatalErrors: ScanResult['errors'] = [];
        for (const item of result.errors) {
            if (item.parent.startsWith('npm:')) {
                softNpmErrors++;
                log.debug('deps', () => `ignored npm-internal "${item.spec}" from "${item.parent}": ${item.error}`);
            } else {
                fatalErrors.push(item);
                prog?.clearForOutput();
                log.warn('deps', () => `"${item.spec}" from "${item.parent}": ${item.error}`);
            }
        }
        if (softNpmErrors > 0) {
            prog?.clearForOutput();
            log.warn('deps', () => `${softNpmErrors} npm-internal dependency error(s) ignored during precache`);
        }
        log.debug('precache', () => `scan complete: ${result.modules.length} modules, ${result.errors.length} errors`);
        this.resolver.rewriteLock();
        if (fatalErrors.length > 0) {
            prog?.stop();
            this.resources.release();
            await parseDriver.terminate();
            throw new Error(`Precache failed with ${fatalErrors.length} dependency error(s)`);
        }

        const scannableModules: Array<{ specPath: string; localPath: string }> = [];
        const toCompile: Array<{ specPath: string; localPath: string }> = [];
        for (const m of result.modules) {
            if (!isPrecompilePath(m.localPath)) continue;
            scannableModules.push(m);
            if (!this.compiler.esm.jsc.hasFresh(m.localPath, isRemote(m.specPath))) {
                toCompile.push(m);
            }
        }

        if (toCompile.length > 0) {
            try {
                log.debug('precache', () => `precompile begin: ${toCompile.length}/${scannableModules.length} modules`);
                prog?.setCompileProgress(0, toCompile.length);
                // Stream each bytecode straight to disk and drop it — never hold
                // the whole graph's bytecode in memory (peak RSS bound).
                let written = 0;
                await parseDriver.compileModules(
                    toCompile,
                    (done, total) => prog?.setCompileProgress(done, total),
                    (localPath, bc, specPath) => {
                        this.compiler.esm.jsc.persistBytecode(localPath, bc, isRemote(specPath));
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

    private async retryScanErrors(result: ScanResult): Promise<void> {
        if (!result.errors.length) return;
        const known = new Set<string>();
        for (let i = 0; i < result.modules.length; i++) {
            const module = result.modules[i];
            if (module) known.add(module.specPath);
        }
        const remaining: ScanResult['errors'] = [];
        for (const item of result.errors) {
            try {
                const info = await this.resolver.resolveAsync(item.spec, item.parent);
                if (!known.has(info.specPath)) {
                    known.add(info.specPath);
                    result.modules.push({ specPath: info.specPath, localPath: info.localPath });
                }
                log.debug('deps', () => `retry ok "${item.spec}" from "${item.parent}"`);
            } catch (e) {
                const message = errMsg(e);
                log.debug('deps', () => `retry failed "${item.spec}" from "${item.parent}": ${message}`);
                remaining.push({ ...item, error: message });
            }
        }
        result.errors.splice(0, result.errors.length, ...remaining);
    }

    private async runLifecycleScripts(progress: PrecacheProgress | null = null): Promise<number> {
        const scripts = this.resolver.drainLifecycleScripts();
        if (!scripts.length) return 0;
        const isWin = isWindows;
        const shell = isWin ? 'cmd.exe' : 'sh';
        const shellArg = isWin ? '/c' : '-c';
        for (const { name, version, dir, lifecycle, script } of scripts) {
            log.debug('lifecycle', () => `${lifecycle} ${name}@${version}: ${script}`);
            if (!this.config.silent) {
                progress?.clearForOutput();
                console.log(`  ${lifecycle}: ${name}@${version}`);
            }
            let code: number;
            try {
                code = await this.runLifecycleScript(script, dir, shell, shellArg);
            } catch (e) {
                const message = `${lifecycle} ${name}@${version} failed: ${errMsg(e)}`;
                progress?.clearForOutput();
                log.warn('lifecycle', () => message);
                continue;
            }
            if (code !== 0) {
                const message = `${lifecycle} ${name}@${version} exited with code ${code}`;
                progress?.clearForOutput();
                log.warn('lifecycle', () => message);
                continue;
            }
        }
        return scripts.length;
    }

    private async runLifecycleScript(script: string, cwd: string, shell: string, shellArg: string): Promise<number> {
        const plan = planLifecycleScript(script, { exePath: os.exePath, shell, shellArg });
        return runLifecyclePlan(plan, (command) => this.spawnLifecycleCommand(command, cwd));
    }

    private async spawnLifecycleCommand(command: LifecycleCommand, cwd: string): Promise<number> {
        const argv = resolveLifecycleCommandArgv(command.argv, (name) => this.resolver.resolveBin(name, cwd));
        log.debug('lifecycle', () => `spawn: ${argv.join(' ')}`);
        const child = process.spawn(argv, {
            cwd,
            stdin: 'inherit',
            stdout: 'pipe',
            stderr: 'pipe',
            env: lifecycleEnv(cwd),
        });
        const stdout = drainPipe(child.stdout);
        const stderr = drainPipe(child.stderr);
        const info = await child.wait();
        await Promise.allSettled([stdout, stderr]);
        return info.exit_status ?? 0;
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
        const meta: Record<string, unknown> = {};
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

    async loadEntry(path: string, extra: Record<string, unknown> = {}, lang = 'ts'): Promise<CModuleEngine.Module> {
        const info = this.resolver.resolve(path, `${os.cwd}/<entry>`);
        const meta: Record<string, unknown> = { lang, ...extra };
        fillMeta(meta, info, this.resolver);
        meta.main = true;
        return this.compiler.load(info, meta);
    }

    async loadModule(path: string, extra: Record<string, unknown> = {}, lang = 'ts'): Promise<CModuleEngine.Module> {
        const info = this.resolver.resolve(path, `${os.cwd}/<entry>`);
        const meta: Record<string, unknown> = { lang, ...extra };
        fillMeta(meta, info, this.resolver);
        return this.compiler.load(info, meta);
    }

    loadSourceEntry(
        code: string,
        path: string,
        extra: Record<string, unknown> = {},
        opts: { lang?: string; format?: ModuleFormat; fileKind?: FileKind } = {},
    ): CModuleEngine.Module {
        this.resolver.entry = path;
        const info: ModuleInfo = {
            specPath: path,
            localPath: path,
            format: opts.format ?? 'esm',
            fileKind: opts.fileKind ?? 'source',
        };
        const meta: Record<string, unknown> = { lang: opts.lang ?? 'ts', ...extra };
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
        const cause = e.cause;
        if (!cause || typeof cause !== 'object') {
            log.debug('runtime', () => `reportSyntax: malformed cause, rethrowing`);
            throw e;
        }
        const source = Reflect.get(cause, 'source');
        const code = Reflect.get(cause, 'code');
        const path = Reflect.get(cause, 'path');
        if (!(source instanceof SyntaxError) || typeof code !== 'string' || typeof path !== 'string') {
            log.debug('runtime', () => `reportSyntax: malformed cause, rethrowing`);
            throw e;
        }
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
