import { err, ErrorKind, requireCycleError } from '../errors';
import type { OxcTranspiler } from '../oxc';
import type { ModuleResolver } from '../resolve/index';
import { isTypeDecl } from '../resolve/protocols/base';
import { moduleRef, type ModuleInfo, type RuntimeConfig } from '../types';
import { bridgeCjsToEsm, buildCjsDeps, installGlobalRequire, installInternalBridge } from './bridge';
import { CjsLoader } from './cjs';
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
     * Module → localPath, so `evalTracked` can name the module it is about to
     * evaluate. Weak: the Module is owned by esmCache/wasmCache, and a compiler
     * that outlives a dropped module must not pin it.
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
            // Same hazard as loadEsmSync (see bridge.ts): a WASM module whose JS
            // glue require()s the .wasm back reaches wasm.load's cache and gets
            // the *same* Module object, already in JS_MODULE_STATUS_EVALUATING.
            // That status is absent from js_link_module's allow-list
            // (quickjs.c:32089) and .eval() aborts the process instead of
            // throwing. Check before wasm.load, which would hand back the
            // placeholder and lose the fact that this was a cycle.
            if (this.esm.isInFlight(info.localPath)) {
                throw requireCycleError(info.localPath, '<wasm>', 'require-esm');
            }
            const mod = this.wasm.load(
                info,
                (spec, parent) => this.resolver.resolve(spec, parent),
                (resolved, meta) => this.load(resolved, meta),
                (m) => this.evalTracked(m),
            );
            const result = engine.promiseResult(
                this.esm.trackEvaluation(info.localPath, () => mod.eval()),
            );
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
        this.modulePaths.set(mod, info.localPath);
        return mod;
    }

    /**
     * Evaluate a module loaded by this compiler with its localPath marked as
     * evaluating, exactly as loadEsmSync does (bridge.ts:117).
     *
     * Every entry-eval site must use this instead of a bare `mod.eval()`. Without
     * the window, a module that is the *process entry* can require() itself (or be
     * required back by a CJS module it pulls in) and loadEsmSync's isInFlight
     * check sees nothing: esmInFlightPaths was already cleared when compilation
     * finished, and nothing marks the evaluation. loadEsmSync then calls .eval()
     * on a module in JS_MODULE_STATUS_EVALUATING, which js_link_module does not
     * allow (quickjs.c:32089) — the process aborts (rc=3) instead of throwing
     * ERR_REQUIRE_CYCLE_MODULE. The same cycle reached through require() from a
     * CJS entry already threw correctly, because that route goes via loadEsmSync.
     *
     * The window is deliberately only as wide as the *synchronous* part of
     * evaluation: trackEvaluation's finally runs when `.eval()` returns its
     * promise, not when that promise settles. Synchronous self-require — the
     * whole defect — happens inside it. Holding the flag across the await would
     * instead make a legitimate post-evaluation require() (from a timer or an
     * async callback) throw a spurious cycle error, and would strand the flag
     * for any entry that never settles.
     *
     * Returns whatever `.eval()` returns (a promise); unlike loadEsmSync this
     * does NOT apply promiseResult, because callers await normally.
     */
    evalTracked(mod: CModuleEngine.Module): ReturnType<CModuleEngine.Module['eval']> {
        const localPath = this.modulePaths.get(mod);
        // Not from this compiler (e.g. a raw `new engine.Module`): nothing to key
        // the window on, and such a module is not in esmCache, so no require()
        // can reach it mid-evaluation.
        if (localPath === undefined) return mod.eval();
        return this.esm.trackEvaluation(localPath, () => mod.eval());
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
