// runtime/hooks.ts — Engine hooks (engine.onModule)
//
// Wires the QuickJS module system to our resolve -> source -> compile pipeline.
// The four hooks:
//   resolve: spec + parent -> specPath (calls resolver)
//   load:    specPath -> Module (calls compiler)
//   init:    specPath -> fill import.meta
//   attrchk: validate import attributes

import type { ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import type { ModuleCompiler } from '../compile/index';
import { fillMeta } from './meta';
import { errMsg } from '../utils/misc';
import { err, ErrorKind } from '../errors';
import { log } from '../utils/log';

const engine = import.meta.use('engine');

const SUPPORTED_ATTRS = new Set(['type', 'raw', 'text', 'bytes']);

export interface EngineHookCallbacks {
    onInitHook?: (specPath: string, info: ModuleInfo) => void;
    onSyntaxError?: (e: SyntaxError) => never;
}

/**
 * Install engine.onModule hooks that wire resolve -> load -> init.
 */
export function installEngineHooks(
    resolver: ModuleResolver,
    compiler: ModuleCompiler,
    callbacks: EngineHookCallbacks = {},
): void {
    // Cache meta between load and init for the same specPath
    const metaCache = new Map<string, Record<string, any>>();
    // Dedup: QuickJS does not cache dynamic import() results, so the
    // same specPath may arrive multiple times. Return the already
    // compiled Module on repeat calls.
    const loadedModules = new Map<string, CModuleEngine.Module>();

    engine.onModule({
        resolve(spec: string, parent: string, attr?: Record<string, any>): string {
            try {
                const info = resolver.resolve(spec, parent, attr);
                compiler.preRegister(info.localPath, parentLocal(resolver, parent));
                return info.specPath;
            } catch (e) {
                throw err(ErrorKind.ModuleNotFound,
                    `Cannot resolve "${spec}" from "${parent}": ${errMsg(e)}`);
            }
        },

        load(specPath: string): CModuleEngine.Module {
            log.debug('runtime', () => `load hook: ${specPath}`);
            const dedup = loadedModules.get(specPath);
            if (dedup) return dedup;

            const info = resolver.getInfo(specPath);
            const meta: Record<string, any> = {};
            fillMeta(meta, info, resolver);
            metaCache.set(specPath, meta);

            try {
                const mod = compiler.load(info, meta);
                loadedModules.set(specPath, mod);
                metaCache.delete(specPath);
                return mod;
            } catch (e) {
                metaCache.delete(specPath);
                if (e instanceof SyntaxError && (e.cause as any)?.source && callbacks.onSyntaxError) {
                    callbacks.onSyntaxError(e);
                }
                throw e;
            }
        },

        init(specPath: string, importMeta: Record<string, any>): void {
            log.debug('runtime', () => `init hook: ${specPath}`);
            const cached = metaCache.get(specPath);
            const info = resolver.getInfo(specPath);
            if (cached) {
                Object.assign(importMeta, cached);
            } else {
                fillMeta(importMeta, info, resolver);
            }
            callbacks.onInitHook?.(specPath, info);
        },

        attrchk(attr: Record<string, any>): void {
            const unknown = Object.keys(attr).filter(k => !SUPPORTED_ATTRS.has(k));
            if (unknown.length) log.debug('runtime', () => `unknown attrs: ${unknown.join(', ')}`);
        },
    });
}

function parentLocal(resolver: ModuleResolver, parent: string): string {
    try { return resolver.getInfo(parent).localPath; }
    catch { return parent; }
}
