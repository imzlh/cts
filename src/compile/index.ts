import { err, ErrorKind, requireCycleError } from '../errors';
import type { OxcTranspiler } from '../oxc';
import type { ModuleResolver } from '../resolve/index';
import { isTypeDecl } from '../resolve/protocols/base';
import { moduleEvaluationKey, moduleRef, type ModuleInfo, type RuntimeConfig } from '../types';
import { bridgeCjsToEsm, buildCjsDeps, installGlobalRequire, installInternalBridge } from './bridge';
import { CjsLoader, clearDirPathsCache } from './cjs';
import { EsmCompiler } from './esm';
import { WasmCompiler } from './wasm';

const engine = import.meta.use('engine');

function metaLang(meta: Record<string, unknown>): string | undefined {
    return typeof meta.lang === 'string' ? meta.lang : undefined;
}

export class ModuleCompiler {
    readonly esm: EsmCompiler;
    readonly cjs: CjsLoader;
    readonly wasm: WasmCompiler;

    /**
     * Weak so a compiler outliving a dropped module (owned by esmCache/wasmCache) does not pin it.
     */
    private readonly modulePaths = new WeakMap<CModuleEngine.Module, string>();

    constructor(
        private readonly resolver: ModuleResolver,
        cfg: RuntimeConfig,
    ) {
        this.esm = new EsmCompiler(cfg);
        this.wasm = new WasmCompiler();

        // Wire CjsLoader to resolver + ESM compiler via bridge callbacks
        const deps = buildCjsDeps(resolver, this.esm, (info) => {
            const wasmRef = moduleRef(info);
            // Same hazard as loadEsmSync (see bridge.ts): a WASM module whose JS
            // glue require()s the .wasm back reaches wasm.load's cache and gets
            // the *same* Module object, already in JS_MODULE_STATUS_EVALUATING.
            // That status is absent from js_link_module's allow-list
            // (quickjs.c:32089) and .eval() aborts the process instead of
            // throwing. Check before wasm.load, which would hand back the
            // placeholder and lose the fact that this was a cycle.
            const evalScope = moduleEvaluationKey(info);
            if (this.esm.isInFlight(evalScope)) {
                throw requireCycleError(wasmRef, '<wasm>', 'require-esm');
            }
            const mod = this.wasm.load(
                info,
                (spec, parent) => this.resolver.resolve(spec, parent),
                (resolved, meta) => this.load(resolved, meta),
                (m) => this.evalTracked(m),
            );
            const result = engine.promiseResult(
                this.esm.trackEvaluation(evalScope, () => mod.eval()),
            );
            if (result === null) {
                throw err(ErrorKind.Generic,
                    `Cannot require() async WASM module '${info.specPath}'`,
                    undefined, 'ERR_REQUIRE_ASYNC_MODULE');
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
            {
                replaceCache: (value) => this.cjs.replaceCache(value),
                resetCache: (value) => this.cjs.resetCache(value),
                replaceExtensions: (value) => this.cjs.replaceExtensions(value),
                resetExtensions: () => this.cjs.resetExtensions(),
            },
        );
    }

    setOxc(oxc: OxcTranspiler): void {
        this.esm.setOxc(oxc);
    }

    setOxcLoader(loader: () => OxcTranspiler | null): void {
        this.esm.setOxcLoader(loader);
    }

    /** Release process-wide CJS path search state when a runtime is disposed. */
    clearRuntimeCaches(): void {
        clearDirPathsCache();
    }

    load(info: ModuleInfo, meta: Record<string, unknown> = {}): CModuleEngine.Module {
        return this.remember(this.loadInner(info, meta), info);
    }

    private loadInner(info: ModuleInfo, meta: Record<string, unknown> = {}): CModuleEngine.Module {
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
                (m) => this.evalTracked(m),
            );
        }

        // CJS format: execute via CjsLoader, then bridge to ESM Module
        if (info.format === 'cjs' && info.fileKind === 'source') {
            // Cycle: this CJS body is already on the stack, so the ESM module
            // being compiled right now imports a module that is mid-execution.
            // loadAndGet's `loaded || executing` guard would bridge the partial
            // exports; Node refuses outright with ERR_REQUIRE_CYCLE_MODULE.
            // Keep this ahead of loadAndGet — never re-enter the body, which is
            // what caused the original segfault.
            const cycle = this.cjs.importCycleError(info.localPath);
            if (cycle) throw cycle;
            const cjsMod = this.cjs.loadAndGet(info.localPath, undefined, info.specPath === this.resolver.entry);
            const mod = bridgeCjsToEsm(moduleRef(info), meta, cjsMod.exports);
            this.esm.setCache(info, mod);
            return mod;
        }

        // ESM / JSON / binary / text: delegate to ESM compiler
        return this.esm.load(info, meta);
    }

    loadSource(code: string, info: ModuleInfo, meta: Record<string, unknown> = {}): CModuleEngine.Module {
        return this.remember(this.loadSourceInner(code, info, meta), info);
    }

    private loadSourceInner(code: string, info: ModuleInfo, meta: Record<string, unknown> = {}): CModuleEngine.Module {
        if (info.fileKind === 'text') {
            return this.esm.loadSource(code, info, meta);
        }
        if (info.format === 'cjs') {
            const transformed = this.esm.transformer.transformForCjs(code, info.localPath, metaLang(meta));
            const cjsMod = this.cjs.loadSourceAndGet(transformed, info.localPath);
            const mod = bridgeCjsToEsm(moduleRef(info), meta, cjsMod.exports);
            this.esm.setCache(info, mod);
            return mod;
        }
        return this.esm.loadSource(code, info, meta);
    }

    private remember(mod: CModuleEngine.Module, info: ModuleInfo): CModuleEngine.Module {
        this.modulePaths.set(mod, moduleEvaluationKey(info));
        return mod;
    }

    /**
     * Guard synchronous self-require during entry evaluation. Clear the guard
     * when eval() returns its promise; keeping it until settlement rejects valid
     * later require() calls and strands entries with unresolved top-level await.
     */
    evalTracked(mod: CModuleEngine.Module): ReturnType<CModuleEngine.Module['eval']> {
        const evalScope = this.modulePaths.get(mod);
        if (evalScope === undefined) return mod.eval();
        return this.esm.trackEvaluation(evalScope, () => mod.eval());
    }

    preRegister(localPath: string, parentPath: string): void {
        this.cjs.preRegister(localPath, parentPath);
    }

    requireInternal(id: string, parentPath?: string): unknown {
        return this.cjs.mkRequire(parentPath ?? `${this.resolver.entry}/../<internal>`)(id);
    }

    clearLoadedModules(): void {
        this.esm.clearLoadedModules();
        this.cjs.clearLoadedModules();
        this.wasm.clearCache();
    }

    hasPendingLoads(): boolean {
        return this.esm.hasPendingLoads() || this.wasm.hasPendingLoads();
    }
}
