// runtime.ts — TypeScriptRuntime

import type { RuntimeConfig, NodeBuiltinResolver, ModuleInfo } from './types';
import type { ScanResult } from './deps';
import { ModuleResolver } from './resolver';
import { ModuleLoader }   from './loader';
import { DepScanner }     from './deps';
import { createConfig }   from './config';
import { PrecompileDriver, isCompilerWorker, runCompilerWorker } from './precompile';
import { PrecacheProgress } from './utils/progress';
import { resources }      from './resources';
import { dirname, normalizePath, isAbsolute, joinPaths } from './utils/path';
import { writeText, ensureDir, resolveFile } from './utils/io';
import { errMsg } from './utils/misc';
import { err, ErrorKind, formatError } from './errors';
import { guessFileKind } from './protocol/base';
import { uname } from './utils';
import { log } from './utils/log';
import { isRemote } from './jsc';
import { tryLoadOxc, type OxcTranspiler } from './oxc';

const os = import.meta.use('os');
const console = import.meta.use('console');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const process = import.meta.use('process');

const SUPPORTED_ATTRS = new Set(['type', 'raw', 'text', 'bytes']);

export class TypeScriptRuntime {
    readonly resolver: ModuleResolver;
    readonly loader:   ModuleLoader;
    readonly config:   RuntimeConfig;
    private readonly metaCache = new Map<string, Record<string, any>>();
    private readonly oxc: OxcTranspiler | null;
    /** Load dedup: specPath → Module. Ensures the engine never loads the same
     *  module twice (QuickJS does not cache dynamic import() results). */
    private readonly loadedModules = new Map<string, CModuleEngine.Module>();
    private readonly initHooks: Array<(specPath: string, info: ModuleInfo) => void> = [];
    /** Reusable meta object — avoids per-load allocation. */
    private readonly _meta: Record<string, any> = {};
    /** Cached resolve closures keyed by specPath — avoids per-load closure allocation. */
    private readonly resolveFnCache = new Map<string, (s: string, p?: string, a?: Record<string, any>) => string>();

    /** Register an additional callback to fire after each module's init hook. */
    addInitHook(fn: (specPath: string, info: ModuleInfo) => void): void {
        this.initHooks.push(fn);
    }

    constructor(cfg: RuntimeConfig, entryDir?: string) {
        this.config   = cfg;
        this.resolver = new ModuleResolver(
            cfg,
            cfg.noLock ? undefined : (cfg.lockDir ?? entryDir ?? os.cwd),
            cfg.noLock ?? false,
        );
        this.loader = new ModuleLoader(this.resolver, cfg);
        this.oxc = tryLoadOxc();
        if (this.oxc) this.loader.setOxc(this.oxc);
        this.hookEngine();
        this.hookEvents();

        // Register handler cache cleanup to run during resource release
        resources.register(() => this.resolver.clearHandlerCaches());
    }

    // -------------------------------------------------------------------------
    // Engine hooks
    // -------------------------------------------------------------------------

    private hookEngine(): void {
        engine.onModule({
            resolve: (spec: string, parent: string, attr?: Record<string, any>): string => {
                try {
                    const info = this.resolver.resolve(spec, parent, attr);
                    this.loader.preRegister(info.localPath, this.parentLocal(parent));
                    return info.specPath;
                } catch (e) {
                    throw err(ErrorKind.ModuleNotFound, `Cannot resolve "${spec}" from "${parent}": ${errMsg(e)}`);
                }
            },

            load: (specPath: string): CModuleEngine.Module => {
                log.debug('runtime', () => `load hook called for ${specPath}`);
                // Dedup: QuickJS does not cache dynamic import() results, so the
                // same specPath may arrive multiple times. Return the already
                // compiled Module on repeat calls.
                const dedup = this.loadedModules.get(specPath);
                if (dedup) return dedup;
                const info = this.resolver.getInfo(specPath);
                // Reuse meta object — loader.load copies properties out synchronously
                const meta = this._meta;
                this.fillMeta(meta, info);
                // Cache meta for init hook to apply
                this.metaCache.set(specPath, meta);
                try {
                    const mod = this.loader.load(info, meta);
                    // Register in dedup cache so repeat loads return the same Module
                    this.loadedModules.set(specPath, mod);
                    // Clean up cache after load
                    this.metaCache.delete(specPath);
                    return mod;
                }
                catch (e) {
                    this.metaCache.delete(specPath);
                    if (e instanceof SyntaxError && (e.cause as any)?.source)
                        this.reportSyntax(e);
                    throw e;
                }
            },

            init: (specPath: string, importMeta: Record<string, any>): void => {
                log.debug('runtime', () => `init hook called for ${specPath}`);
                const cached = this.metaCache.get(specPath);
                const info = this.resolver.getInfo(specPath);
                if (cached) {
                    Object.assign(importMeta, cached);
                } else {
                    this.fillMeta(importMeta, info);
                }
                // Fire additional init hooks (e.g. CDP scriptParsed)
                for (const fn of this.initHooks) {
                    try { fn(specPath, info); } catch {}
                }
            },

            attrchk: (attr: Record<string, any>): void => {
                const unknown = Object.keys(attr).filter(k => !SUPPORTED_ATTRS.has(k));
                if (unknown.length) log.debug('runtime', () => `unknown attrs: ${unknown.join(', ')}`);
            },
        });
    }

    private hookEvents(): void {
        const trace = new Set();
        engine.onEvent((name: number, data) => {
            const ET = engine.EventType;
            if (name === ET.UNHANDLED_REJECTION) {
                // @ts-ignore
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
    // import.meta
    // -------------------------------------------------------------------------

    private fillMeta(meta: Record<string, any>, info: ModuleInfo): void {
        const remote  = isRemote(info.specPath);
        meta.url      = remote ? info.specPath : `file:///${info.localPath.replace(/^\//, '')}`;
        meta.filename = info.localPath;
        meta.dirname  = dirname(info.localPath);
        meta.main     = info.specPath === this.resolver.entry;
        meta.use      = import.meta.use;
        // import.meta.resolve — reuse cached closure per specPath
        let fn = this.resolveFnCache.get(info.specPath);
        if (!fn) {
            const self = info.specPath;
            fn = (s: string, p?: string, a?: Record<string, any>) =>
                this.resolver.resolve(s, p ?? self, a).specPath;
            this.resolveFnCache.set(info.specPath, fn);
        }
        meta.resolve = fn;
    }

    private parentLocal(parent: string): string {
        try { return this.resolver.getInfo(parent).localPath; }
        catch { return parent; }
    }

    // -------------------------------------------------------------------------
    // Pre-cache: async parallel BFS, then full resource cleanup
    // -------------------------------------------------------------------------

    async precache(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult> {
        const result = await this.runPrecache((scanner) =>
            scanner.scan(entrySpecPath, entryLocalPath)
        );
        return result;
    }

    /**
     * Pre-cache from an explicit set of specifiers (no entry file).
     */
    async precacheFromSpecifiers(specifiers: string[], dir: string): Promise<ScanResult> {
        const result = await this.runPrecache((scanner) =>
            scanner.scanFromSpecifiers(specifiers, dir)
        );
        return result;
    }

    // -------------------------------------------------------------------------
    // Shared precache implementation
    // -------------------------------------------------------------------------

    private async runPrecache(
        scanFn: (scanner: DepScanner) => Promise<ScanResult>,
    ): Promise<ScanResult> {
        const prog = this.config.silent ? null : new PrecacheProgress(6);
        // Driver created early so its worker pool serves import scanning during BFS
        const driver = new PrecompileDriver();
        const scanner = new DepScanner(this.resolver, this.config, prog, this.oxc, driver.scanFile.bind(driver));
        let result;
        try {
            log.debug('deps', () => 'scan begin');
            const scanStarted = Date.now();
            result = await scanFn(scanner);
            log.debug('deps', () => `scan done in ${Date.now() - scanStarted}ms`);
        } catch (e) {
            // Even on catastrophic failure, flush whatever we resolved so far
            try { this.resolver.rewriteLock(); } catch {}
            prog?.stop();
            resources.release();
            await driver.terminate();
            throw e;
        }
        for (const { spec, parent, error } of result.errors)
            log.warn('deps', () => `"${spec}" from "${parent}": ${error}`);
        log.info(`[precache] scan complete: ${result.modules.length} modules, ${result.errors.length} errors`);
        this.resolver.rewriteLock();

        // Run postinstall lifecycle scripts (only during cno cache)
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
                    this.loader.jsc.setMemory(localPath, bc);
                for (const m of toCompile) {
                    if (isRemote(m.specPath))
                        this.loader.jsc.persistMemory(m.localPath);
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
        resources.release();
        return result;
    }

    private async runPostinstallScripts(): Promise<void> {
        const scripts = this.resolver.drainPostinstall();
        if (!scripts.length) return;
        const isWin = uname.sysname.includes('Windows');
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
    // Polyfill + entry — release resources before handing to user code
    // -------------------------------------------------------------------------

    async loadPolyfill(path: string): Promise<void> {
        // Resolve the polyfill path directly — skip the full resolver chain
        // (import map, lock lookup, protocol dispatch) since polyfills are
        // always local files and resolving them through the full pipeline is
        // both slow and fragile (e.g. lock writes with synthetic parents).
        const localPath = this.resolvePolyfillPath(path);
        const specPath  = localPath;   // local file → specPath === localPath
        const info: ModuleInfo = {
            specPath,
            localPath,
            format: 'esm',           // polyfill is always treated as ESM
            fileKind: guessFileKind(localPath),
        };
        const meta: Record<string, any> = {};
        this.fillMeta(meta, info);
        meta.polyfill = true;
        await this.loader.load(info, meta).eval();
        log.debug('runtime', () => `polyfill: ${specPath}`);
    }

    /** Resolve a polyfill path to an absolute local file path. */
    private resolvePolyfillPath(path: string): string {
        // Normalize Windows backslashes to forward slashes first
        const normalized = path.replace(/\\/g, '/');
        // Already absolute
        if (isAbsolute(normalized)) return resolveFile(normalizePath(normalized));
        // Relative to cwd — also normalize os.cwd on Windows
        const cwd = String(os.cwd).replace(/\\/g, '/');
        return resolveFile(normalizePath(joinPaths(cwd, normalized)));
    }

    async loadEntry(path: string, extra: Record<string, any> = {}, lang = 'ts'): Promise<CModuleEngine.Module> {
        // Do NOT call resources.release() here — user code may trigger dynamic
        // imports whose protocol handlers still rely on resolver/handler state
        // (e.g. HttpHandler.resolved, NpmHandler.verCache).  Release happens
        // after the entry module has fully settled in the caller (run.ts).

        const info = this.resolver.resolve(path, `${os.cwd}/<entry>`);
        // Entry file is always treated as executable ESM source,
        // regardless of extension (e.g. extensionless scripts).
        info.fileKind = 'source';
        info.format = 'esm';
        const meta: Record<string, any> = { lang, ...extra };
        this.fillMeta(meta, info);
        meta.main = true;
        return this.loader.load(info, meta);
    }

    registerNodeResolver(r: NodeBuiltinResolver): void {
        this.resolver.registerNodeResolver(r);
    }

    flushLock(): void   { this.resolver.flushLock(); }
    get rtConfig(): RuntimeConfig { return this.config; }

    /** Clean up runtime caches and loaded modules */
    cleanup(): void {
        if (this.loader.hasPendingLoads()) {
            log.warn('runtime', () => 'cleanup() called while async loads are in-flight — skipping cache clear to avoid use-after-free');
            return;
        }
        this.loader.clearLoadedModules();
        this.loader.jsc.clearMemory();
        this.loadedModules.clear();
        this.metaCache.clear();
        this.resolver.clearHandlerCaches();
    }

    private reportSyntax(e: SyntaxError): never {
        const { source, code, path } = e.cause as { source: SyntaxError; code: string; path: string };
        const hash    = crypto.hexEncode(crypto.md5(engine.encodeString(path)));
        const logPath = `${this.config.cacheDir}/fail-${hash}.log`;
        ensureDir(dirname(logPath));
        writeText(logPath, [
            `cts SyntaxError (${new Date().toISOString()})`,
            `${source.name}: ${source.message}`, source.stack ?? '',
            '-'.repeat(50), `File: ${path}`,
            code.split('\n').map((l, i) => `${(i+1).toString().padStart(4)} | ${l}`).join('\n'),
        ].join('\n'));
        throw new SyntaxError(`${source.message} (see ${logPath})`, { cause: e.cause });
    }
}

export function createRuntime(cfg: Partial<RuntimeConfig> = {}, entryDir?: string): TypeScriptRuntime {
    return new TypeScriptRuntime(createConfig(cfg), entryDir);
}
