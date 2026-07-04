// runtime/hooks.ts — Engine hooks (engine.onModule)
//
// C layer constraint: engine.onModule is REPLACEMENT (not append).
// Only one set of hooks active per process — second runtime hijacks the first.

import { moduleRef, type ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import type { ModuleCompiler } from '../compile/index';
import { fillMeta } from './meta';
import { errMsg, log } from '../utils';
import { err, ErrorKind } from '../errors';

const engine = import.meta.use('engine');

const SUPPORTED_ATTRS = new Set(['type', 'raw', 'text', 'bytes']);
let activeInstall = false;

export interface EngineHookCallbacks {
    onInitHook?: (specPath: string, info: ModuleInfo) => void;
    onSyntaxError?: (e: SyntaxError) => never;
}

export interface EngineHooks {
    clearLoadedModules(): void;
}

/**
 * Install engine.onModule hooks that wire resolve -> load -> init.
 * Warns on re-install because C layer replaces (not appends) the prior hooks.
 */
export function installEngineHooks(
    resolver: ModuleResolver,
    compiler: ModuleCompiler,
    callbacks: EngineHookCallbacks = {},
): EngineHooks {
    if (activeInstall) log.warn('runtime', () => 'engine.onModule re-installed — prior runtime hooks replaced');
    activeInstall = true;

    // Dedup: QuickJS does not cache dynamic import() results, so the
    // same runtime module ref may arrive multiple times.
    const loadedModules = new Map<string, CModuleEngine.Module>();

    engine.onModule({
        resolve(spec: string, parent: string, attr?: Record<string, any>): string {
            try {
                const info = resolver.resolve(spec, parent, attr);
                compiler.preRegister(info.localPath, parentLocal(parent));
                return moduleRef(info);
            } catch (e) {
                throw err(ErrorKind.ModuleNotFound,
                    `Cannot resolve "${spec}" from "${parent}": ${errMsg(e)}`, e);
            }
        },

        load(specPath: string): CModuleEngine.Module {
            log.debug('runtime', () => `load hook: ${specPath}`);
            const info = resolver.getInfo(specPath);
            const key = moduleKey(info);
            const meta: Record<string, any> = {};
            fillMeta(meta, info, resolver);

            const dedup = loadedModules.get(key);
            if (dedup) return dedup;

            try {
                const mod = compiler.load(info, meta);
                loadedModules.set(key, mod);
                return mod;
            } catch (e) {
                if (e instanceof SyntaxError && (e.cause as any)?.source && callbacks.onSyntaxError) {
                    callbacks.onSyntaxError(e);
                }
                throw e;
            }
        },

        init(specPath: string, importMeta: Record<string, any>): void {
            log.debug('runtime', () => `init hook: ${specPath}`);
            const info = resolver.getInfo(specPath);
            fillMeta(importMeta, info, resolver);
            callbacks.onInitHook?.(info.specPath, info);
        },

        attrchk(attr: Record<string, any>): void {
            const unknown = Object.keys(attr).filter(k => !SUPPORTED_ATTRS.has(k));
            if (unknown.length) log.debug('runtime', () => `unknown attrs: ${unknown.join(', ')}`);
        },
    });

    function parentLocal(parent: string): string {
        try { return resolver.getInfo(parent).localPath; }
        catch { return parent; }
    }

    function moduleKey(info: ModuleInfo): string {
        return `${moduleRef(info)}\0${info.fileKind}\0${info.format}`;
    }

    return {
        clearLoadedModules() { loadedModules.clear(); },
    };
}
