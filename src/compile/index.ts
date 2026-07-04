// compile/index.ts — ModuleCompiler facade
//
// Orchestrates ESM, CJS, and WASM compilers.
// Wires CjsLoader to ESM compiler via bridge.ts callbacks.
// This is the single entry point for "compile source into Module".

import { err, ErrorKind } from '../errors';
import type { OxcTranspiler } from '../oxc';
import type { ModuleResolver } from '../resolve/index';
import { isTypeDecl } from '../resolve/protocols/base';
import { moduleRef, type ModuleInfo, type RuntimeConfig } from '../types';
import { bridgeCjsToEsm, buildCjsDeps, installGlobalRequire, installInternalBridge } from './bridge';
import { CjsLoader } from './cjs';
import { EsmCompiler } from './esm';
import { WasmCompiler } from './wasm';

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
        const deps = buildCjsDeps(resolver, this.esm);
        this.cjs = new CjsLoader(deps);

        // Install global require + internal bridge
        installGlobalRequire(
            (entry) => this.cjs.mkRequire(entry),
            () => resolver.entry,
        );
        installInternalBridge(
            (entry) => this.cjs.mkRequire(entry),
            this.cjs.cache,
            resolver,
        );
    }

    setOxc(oxc: OxcTranspiler): void {
        this.esm.setOxc(oxc);
    }

    // -------------------------------------------------------------------------
    // Public API: load a module from its ModuleInfo
    // -------------------------------------------------------------------------

    load(info: ModuleInfo, meta: Record<string, any> = {}): CModuleEngine.Module {
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

        // CJS format: execute via CjsLoader, then bridge to ESM Module
        if (info.format === 'cjs' && info.fileKind === 'source') {
            const cjsMod = this.cjs.loadAndGet(info.localPath);
            const mod = bridgeCjsToEsm(moduleRef(info), meta, cjsMod.exports);
            this.esm.setCache(info, mod);
            return mod;
        }

        // ESM / JSON / binary / text: delegate to ESM compiler
        return this.esm.load(info, meta, (p) => this.resolver.getCachedMtime(p));
    }

    loadSource(code: string, info: ModuleInfo, meta: Record<string, any> = {}): CModuleEngine.Module {
        if (info.fileKind === 'text') {
            return this.esm.loadSource(code, info, meta);
        }
        if (info.format === 'cjs') {
            const transformed = this.esm.transformer.transformForCjs(code, info.localPath, meta?.lang);
            const cjsMod = this.cjs.loadSourceAndGet(transformed, info.localPath);
            const mod = bridgeCjsToEsm(moduleRef(info), meta, cjsMod.exports);
            this.esm.setCache(info, mod);
            return mod;
        }
        return this.esm.loadSource(code, info, meta);
    }

    preRegister(localPath: string, parentPath: string): void {
        this.cjs.preRegister(localPath, parentPath);
    }

    requireInternal(id: string, parentPath?: string): any {
        return this.cjs.mkRequire(parentPath ?? `${this.resolver.entry}/../<internal>`)(id);
    }

    // -------------------------------------------------------------------------
    // Cache management
    // -------------------------------------------------------------------------

    clearLoadedModules(): void {
        this.esm.clearLoadedModules();
        this.wasm.clearCache();
    }

    hasPendingLoads(): boolean {
        return this.esm.hasPendingLoads() || this.wasm.hasPendingLoads();
    }
}
