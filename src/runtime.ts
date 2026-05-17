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
import { err, ErrorKind } from './errors';
import { guessFileKind } from './protocol/base';
import { console, engine, os, crypto, __use_fn } from './utils';
import { log } from './utils/log';
import { isRemote } from './jsc';

const SUPPORTED_ATTRS = new Set(['type', 'raw', 'text', 'bytes']);

export class TypeScriptRuntime {
    readonly resolver: ModuleResolver;
    readonly loader:   ModuleLoader;
    readonly config:   RuntimeConfig;
    private readonly metaCache = new Map<string, Record<string, any>>();

    constructor(cfg: RuntimeConfig, entryDir?: string) {
        this.config   = cfg;
        this.resolver = new ModuleResolver(
            cfg,
            cfg.noLock ? undefined : (cfg.lockDir ?? entryDir ?? os.cwd),
            cfg.noLock ?? false,
        );
        this.loader = new ModuleLoader(this.resolver, cfg);
        this.hookEngine();
        this.hookEvents();
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
                const info = this.resolver.getInfo(specPath);
                const meta: Record<string, any> = {};
                this.fillMeta(meta, info);
                // Cache meta for init hook to apply
                this.metaCache.set(specPath, meta);
                try {
                    const mod = this.loader.load(info, meta);
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
                if (cached) {
                    Object.assign(importMeta, cached);
                } else {
                    this.fillMeta(importMeta, this.resolver.getInfo(specPath));
                }
            },

            attrchk: (attr: Record<string, any>): void => {
                const unknown = Object.keys(attr).filter(k => !SUPPORTED_ATTRS.has(k));
                if (unknown.length) log.debug('runtime', () => `unknown attrs: ${unknown.join(', ')}`);
            },
        });
    }

    private hookEvents(): void {
        // engine.onEvent((name: number, data: any) => {
        //     const ET = engine.EventType;
        //     if (name === ET.UNHANDLED_REJECTION) {
        //         const r = Array.isArray(data) ? data[1] : data;
        //         console.error(formatError(r, 'unhandled promise rejection'));
        //         return false;
        //     }
        //     if (name === ET.JOB_EXCEPTION) {
        //         console.error(formatError(data, 'unhandled job exception'));
        //         return true;
        //     }
        //     return false;
        // });
    }

    // -------------------------------------------------------------------------
    // import.meta
    // -------------------------------------------------------------------------

    // Reuse a single bound resolve function across all import.meta objects
    private readonly metaResolve = (s: string, p: string, a?: Record<string, any>) =>
        this.resolver.resolve(s, p, a).specPath;

    private fillMeta(meta: Record<string, any>, info: ModuleInfo): void {
        const remote  = isRemote(info.specPath);
        meta.url      = remote ? info.specPath : info.localPath;
        meta.filename = info.localPath;
        meta.dirname  = dirname(info.localPath);
        meta.main     = info.specPath === this.resolver.entry;
        meta.use      = __use_fn;
        meta.resolve  = this.metaResolve;
    }

    private parentLocal(parent: string): string {
        try { return this.resolver.getInfo(parent).localPath; }
        catch { return parent; }
    }

    // -------------------------------------------------------------------------
    // Pre-cache: async parallel BFS, then full resource cleanup
    // -------------------------------------------------------------------------

    async precache(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult> {
        const prog = this.config.silent ? null : new PrecacheProgress(6);
        const scanner = new DepScanner(this.resolver, this.config, prog);
        let result;
        try {
            result = await scanner.scan(entrySpecPath, entryLocalPath);
        } finally {
            resources.release();
        }
        for (const { spec, parent, error } of result.errors)
            log.warn('deps', () => `"${spec}" from "${parent}": ${error}`);
        this.resolver.rewriteLock();

        const scannable = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
        const toCompile = result.modules.filter(m => {
            const dot = m.localPath.lastIndexOf('.');
            return dot !== -1 && scannable.has(m.localPath.slice(dot));
        });

        if (toCompile.length > 0) {
            try {
                const driver = new PrecompileDriver();
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
                await driver.terminate();
                log.debug('precompile', () => `${bytecodes.size}/${toCompile.length} modules precompiled`);
            } catch (e) {
                log.debug('precompile', () => `failed: ${errMsg(e)}`);
            }
        }

        prog?.stop();
        return result;
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

    async loadEntry(path: string, extra: Record<string, any> = {}): Promise<CModuleEngine.Module> {
        // Release any leftover pre-cache resources before user code starts.
        // This is a no-op if precache() was never called or already cleaned up.
        resources.release();

        const info = this.resolver.resolve(path, `${os.cwd}/<entry>`);
        const meta: Record<string, any> = { ...extra };
        this.fillMeta(meta, info);
        meta.main = true;
        return this.loader.load(info, meta);
    }

    registerNodeResolver(r: NodeBuiltinResolver): void {
        this.resolver.registerNodeResolver(r);
    }

    flushLock(): void   { this.resolver.flushLock(); }
    get rtConfig(): RuntimeConfig { return this.config; }

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
