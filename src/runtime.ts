// runtime.ts — TypeScriptRuntime

import type { RuntimeConfig, NodeBuiltinResolver, ModuleInfo } from './types';
import { ModuleResolver } from './resolver';
import { ModuleLoader }   from './loader';
import { DepScanner }     from './deps';
import { createConfig }   from './config';
import { resources }      from './resources';
import { dirname }        from './utils/path';
import { writeText, ensureDir } from './utils/io';
import { errMsg } from './utils/misc';
import { console, engine, os, crypto, __use_fn } from './utils';
import { log } from './utils/log';

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
                    return attr?.type ? `${info.specPath}?${attr.type}` : info.specPath;
                } catch (e) {
                    throw new Error(`Cannot resolve "${spec}" from "${parent}": ${errMsg(e)}`);
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
                // Apply cached meta if available (from load hook)
                const cached = this.metaCache.get(specPath);
                if (cached) {
                    Object.assign(importMeta, cached);
                    console.error(`[DEBUG] init applied cached meta, use=${typeof importMeta.use}`);
                } else {
                    this.fillMeta(importMeta, this.resolver.getInfo(specPath));
                    console.error(`[DEBUG] init called fillMeta, use=${typeof importMeta.use}`);
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

    private static isRemote(sp: string): boolean {
        return sp.startsWith('jsr:') || sp.startsWith('http://') || sp.startsWith('https://');
    }

    private fillMeta(meta: Record<string, any>, info: ModuleInfo): void {
        const remote  = TypeScriptRuntime.isRemote(info.specPath);
        meta.url      = remote ? info.specPath : `file://${info.localPath}`;
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

    async precache(entrySpecPath: string, entryLocalPath: string): Promise<void> {
        const scanner = new DepScanner(this.resolver, this.config);
        let result;
        try {
            result = await scanner.scan(entrySpecPath, entryLocalPath);
        } finally {
            // Always release pre-cache resources, even if scan threw
            resources.release();
        }
        for (const { spec, parent, error } of result.errors)
            log.warn('deps', () => `"${spec}" from "${parent}": ${error}`);
        this.resolver.rewriteLock();
    }

    // -------------------------------------------------------------------------
    // Polyfill + entry — release resources before handing to user code
    // -------------------------------------------------------------------------

    async loadPolyfill(path: string): Promise<void> {
        const info = this.resolver.resolve(path, `${os.cwd}/<polyfill>`);
        const meta = {} as Record<string, any>;
        info.format = 'esm';    // polyfill is always ESM!
        this.fillMeta(meta, info);
        meta.polyfill = true;
        await this.loader.load(info, meta).eval();
        log.debug('runtime', () => `polyfill: ${info.specPath}`);
    }

    async loadEntry(path: string, extra: Record<string, any> = {}): Promise<CModuleEngine.Module> {
        // Release any leftover pre-cache resources before user code starts.
        // This is a no-op if precache() was never called or already cleaned up.
        resources.release();

        const info = this.resolver.resolve(path, `${os.cwd}/<entry>`);
        const meta: Record<string, any> = { main: true, ...extra };
        this.fillMeta(meta, info);
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
