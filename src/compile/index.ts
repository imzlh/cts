import { err, ErrorKind } from '../errors';
import type { OxcTranspiler } from '../oxc';
import type { ModuleResolver } from '../resolve/index';
import { isTypeDecl } from '../resolve/protocols/base';
import { hasTopLevelEsmSyntax } from '../scan';
import { moduleRef, type ModuleInfo, type RuntimeConfig } from '../types';
import { readText } from '../utils';
import { bridgeCjsToEsm, buildCjsDeps, installGlobalRequire, installInternalBridge } from './bridge';
import { CjsLoader } from './cjs';
import { EsmCompiler } from './esm';
import { WasmCompiler } from './wasm';

const engine = import.meta.use('engine');

function maybePromoteCjsToEsm(info: ModuleInfo): ModuleInfo {
    if (info.format !== 'cjs' || info.fileKind !== 'source') return info;
    const path = info.localPath;
    // Pack format is sealed at write time — never re-scan source.
    if (path.startsWith('pack:') || path.startsWith('ctsview:')) return info;
    // Only .js/.jsx package sources; .cjs stays CJS always.
    if (path.endsWith('.cjs') || path.endsWith('.cts')) return info;
    if (!path.endsWith('.js') && !path.endsWith('.jsx')) return info;
    try {
        if (!hasTopLevelEsmSyntax(readText(path), false)) return info;
    } catch {
        return info;
    }
    return { ...info, format: 'esm' };
}

function metaLang(meta: Record<string, unknown>): string | undefined {
    return typeof meta.lang === 'string' ? meta.lang : undefined;
}

export class ModuleCompiler {
    readonly esm: EsmCompiler;
    readonly cjs: CjsLoader;
    readonly wasm: WasmCompiler;

    constructor(
        private readonly resolver: ModuleResolver,
        cfg: RuntimeConfig,
    ) {
        this.esm = new EsmCompiler(cfg);
        this.wasm = new WasmCompiler();

        // Wire CjsLoader to resolver + ESM compiler via bridge callbacks
        const deps = buildCjsDeps(resolver, this.esm, (info) => {
            const mod = this.wasm.load(
                info,
                (spec, parent) => this.resolver.resolve(spec, parent),
                (resolved, meta) => this.load(resolved, meta),
            );
            const result = engine.promiseResult(mod.eval());
            if (result === null) {
                throw new Error(`Cannot require() async WASM module '${info.specPath}'`);
            }
            return mod.namespace;
        });
        this.cjs = new CjsLoader(deps);

        // Install global require + internal bridge
        installGlobalRequire(
            (entry) => this.cjs.mkRequire(entry),
            () => resolver.entry,
        );
        installInternalBridge(
            (entry) => this.cjs.mkRequire(entry),
            (id, parentPath) => this.cjs.preloadModule(id, parentPath),
            this.cjs.cache,
            resolver,
        );
    }

    setOxc(oxc: OxcTranspiler): void {
        this.esm.setOxc(oxc);
    }

    setOxcLoader(loader: () => OxcTranspiler | null): void {
        this.esm.setOxcLoader(loader);
    }

    load(info: ModuleInfo, meta: Record<string, unknown> = {}): CModuleEngine.Module {
        if (isTypeDecl(info.localPath)) {
            throw err(ErrorKind.FileNotFound,
                `Cannot load type declaration file "${info.localPath}" as a module.`);
        }

        // WASM has its own cache + circular dep handling
        if (info.fileKind === 'wasm') {
            return this.wasm.load(
                info,
                (spec, parent) => this.resolver.resolve(spec, parent),
                (info, meta) => this.load(info, meta),
            );
        }

        const resolved = maybePromoteCjsToEsm(info);

        // CJS format: execute via CjsLoader, then bridge to ESM Module
        if (resolved.format === 'cjs' && resolved.fileKind === 'source') {
            const cjsMod = this.cjs.loadAndGet(resolved.localPath, undefined, resolved.specPath === this.resolver.entry);
            const mod = bridgeCjsToEsm(moduleRef(resolved), meta, cjsMod.exports);
            this.esm.setCache(resolved, mod);
            return mod;
        }

        // ESM / JSON / binary / text: delegate to ESM compiler
        return this.esm.load(resolved, meta, (p) => this.resolver.getCachedMtime(p));
    }

    loadSource(code: string, info: ModuleInfo, meta: Record<string, unknown> = {}): CModuleEngine.Module {
        if (info.fileKind === 'text') {
            return this.esm.loadSource(code, info, meta);
        }
        let resolved = info;
        if (info.format === 'cjs' && info.fileKind === 'source') {
            const path = info.localPath;
            if (!path.endsWith('.cjs') && !path.endsWith('.cts')
                && (path.endsWith('.js') || path.endsWith('.jsx') || !path.includes('.'))
                && hasTopLevelEsmSyntax(code, false)) {
                resolved = { ...info, format: 'esm' };
            }
        }
        if (resolved.format === 'cjs') {
            const transformed = this.esm.transformer.transformForCjs(code, resolved.localPath, metaLang(meta));
            const cjsMod = this.cjs.loadSourceAndGet(transformed, resolved.localPath);
            const mod = bridgeCjsToEsm(moduleRef(resolved), meta, cjsMod.exports);
            this.esm.setCache(resolved, mod);
            return mod;
        }
        return this.esm.loadSource(code, resolved, meta);
    }

    preRegister(localPath: string, parentPath: string): void {
        this.cjs.preRegister(localPath, parentPath);
    }

    requireInternal(id: string, parentPath?: string): unknown {
        return this.cjs.mkRequire(parentPath ?? `${this.resolver.entry}/../<internal>`)(id);
    }

    clearLoadedModules(): void {
        this.esm.clearLoadedModules();
        this.wasm.clearCache();
    }

    hasPendingLoads(): boolean {
        return this.esm.hasPendingLoads() || this.wasm.hasPendingLoads();
    }
}
