// runtime/index.ts — TypeScriptRuntime (composition root)
//
// Owns the top-level object graph: resolver + compiler + resources.
// Installs engine hooks, manages precache lifecycle, loads entry/polyfill.

import type { RuntimeConfig, NodeBuiltinResolver, ModuleInfo, ModuleFormat, FileKind } from '../types';
import type { ScanResult } from '../deps';
import { ModuleResolver } from '../resolve/index';
import { ModuleCompiler } from '../compile/index';
import { DepScanner } from '../deps';
import { createConfig } from '../config';
import { PrecompileDriver, isCompilerWorker, runCompilerWorker } from '../precompile';
import { PrecacheProgress } from '../utils/progress';
import { ResourceManager, createResourceManager } from './resources';
import { installEngineHooks } from './hooks';
import { fillMeta } from './meta';
import { dirname, normalizePath, isAbsolute, joinPaths, toPosixPath, cwd as posixCwd } from '../utils/path';
import { writeText, ensureDir, resolveFile } from '../utils/io';
import { errMsg } from '../utils/misc';
import { err, ErrorKind, formatError } from '../errors';
import { guessFileKind } from '../resolve/protocols/base';
import { uname, isWindows } from '../utils/index';
import { log } from '../utils/log';
import { isRemote } from '../source/cache';
import { tryLoadOxc, type OxcTranspiler } from '../oxc';

const os = import.meta.use('os');
const console = import.meta.use('console');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const process = import.meta.use('process');

export class TypeScriptRuntime {
    readonly resolver: ModuleResolver;
    readonly compiler: ModuleCompiler;
    readonly config: RuntimeConfig;
    readonly resources: ResourceManager;
    private readonly initHooks: Array<(specPath: string, info: ModuleInfo) => void> = [];
    private readonly oxc: OxcTranspiler | null;

    /** Register an additional callback to fire after each module's init hook. */
    addInitHook(fn: (specPath: string, info: ModuleInfo) => void): void {
        this.initHooks.push(fn);
    }

    constructor(cfg: RuntimeConfig, entryDir?: string) {
        this.config = cfg;
        this.resources = createResourceManager();

        this.resolver = new ModuleResolver(
            cfg,
            cfg.disableLock ? undefined : (cfg.lockDir ?? entryDir ?? os.cwd),
            cfg.disableLock ?? false,
        );

        this.compiler = new ModuleCompiler(this.resolver, cfg);

        this.oxc = tryLoadOxc();
        if (this.oxc) this.compiler.setOxc(this.oxc);

        // Install engine hooks
        installEngineHooks(this.resolver, this.compiler, {
            onInitHook: (specPath, info) => {
                for (const fn of this.initHooks) {
                    try { fn(specPath, info); } catch {}
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
        );
    }

    async precacheFromSpecifiers(specifiers: string[], dir: string): Promise<ScanResult> {
        return this.runPrecache((scanner) =>
            scanner.scanFromSpecifiers(specifiers, dir)
        );
    }

    private async runPrecache(
        scanFn: (scanner: DepScanner) => Promise<ScanResult>,
    ): Promise<ScanResult> {
        const prog = this.config.silent ? null : new PrecacheProgress(6);
        const driver = new PrecompileDriver();
        const scanner = new DepScanner(this.resolver, this.config, prog, this.oxc, driver.scanFile.bind(driver));

        let result: ScanResult;
        try {
            log.debug('deps', () => 'scan begin');
            const scanStarted = Date.now();
            result = await scanFn(scanner);
            log.debug('deps', () => `scan done in ${Date.now() - scanStarted}ms`);
        } catch (e) {
            try { this.resolver.rewriteLock(); } catch {}
            prog?.stop();
            this.resources.release();
            await driver.terminate();
            throw e;
        }

        for (const { spec, parent, error } of result.errors)
            log.warn('deps', () => `"${spec}" from "${parent}": ${error}`);
        log.info(`[precache] scan complete: ${result.modules.length} modules, ${result.errors.length} errors`);
        this.resolver.rewriteLock();

        // Run postinstall lifecycle scripts
        if (!this.config.ignoreScripts) {
            log.info('[precache] postinstall begin');
            await this.runPostinstallScripts();
            log.info('[precache] postinstall end');
        }

        const scannable = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
        const toCompile = result.modules.filter(m => {
            const dot = m.localPath.lastIndexOf('.');
            return dot !== -1 && scannable.has(m.localPath.slice(dot));
        });

        if (toCompile.length > 0) {
            try {
                log.info(`[precache] precompile begin: ${toCompile.length} modules`);
                prog?.setCompileProgress(0, toCompile.length);
                const bytecodes = await driver.precompile(toCompile, (done, total) => {
                    prog?.setCompileProgress(done, total);
                });
                for (const [localPath, bc] of bytecodes)
                    this.compiler.esm.jsc.setMemory(localPath, bc);
                for (const m of toCompile) {
                    if (isRemote(m.specPath))
                        this.compiler.esm.jsc.persistMemory(m.localPath);
                }
                log.debug('precompile', () => `${bytecodes.size}/${toCompile.length} modules precompiled`);
                log.info(`[precache] precompile end: ${bytecodes.size}/${toCompile.length} bytecodes`);
            } catch (e) {
                log.warn('precompile', () => `failed: ${errMsg(e)}`);
            }
        }

        log.info('[precache] worker terminate begin');
        await driver.terminate();
        log.info('[precache] worker terminate end');
        prog?.stop();
        this.resources.release();
        return result;
    }

    private async runPostinstallScripts(): Promise<void> {
        const scripts = this.resolver.drainPostinstall();
        if (!scripts.length) return;
        const isWin = isWindows;
        const shell = isWin ? 'cmd.exe' : 'sh';
        const shellArg = isWin ? '/c' : '-c';
        for (const { name, version, dir, script } of scripts) {
            log.debug('postinstall', () => `${name}@${version}: ${script}`);
            if (!this.config.silent) {
                console.log(`  postinstall: ${name}@${version}`);
            }
            try {
                const child = process.spawn([shell, shellArg, script], {
                    cwd: dir,
                    stdin: 'inherit',
                    stdout: 'inherit',
                    stderr: 'inherit',
                    env: os.environ(),
                });
                const info = await child.wait();
                if (info.exit_status !== 0) {
                    log.warn('postinstall', () => `${name}@${version} exited with code ${info.exit_status}`);
                }
            } catch (e) {
                log.warn('postinstall', () => `${name}@${version} failed: ${errMsg(e)}`);
            }
        }
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
        info.fileKind = 'source';
        info.format = 'esm';
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
        this.compiler.esm.jsc.clearMemory();
        this.resolver.clearHandlerCaches();
    }

    private reportSyntax(e: SyntaxError): never {
        const { source, code, path } = e.cause as { source: SyntaxError; code: string; path: string };
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
