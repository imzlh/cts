import { moduleRef, type ModuleInfo } from '../types';
import type { ModuleResolver } from '../resolve/index';
import type { ModuleCompiler } from '../compile/index';
import { fillMeta } from './meta';
import { errMsg, log } from '../utils';
import { err, ErrorKind } from '../errors';

const engine = import.meta.use('engine');

const SUPPORTED_ATTRS = new Set(['type', 'raw', 'text', 'bytes']);
let activeInstall = false;

function unknownAttrNames(attr: Record<string, unknown>): string {
    let out = '';
    for (const key in attr) {
        if (SUPPORTED_ATTRS.has(key)) continue;
        if (out) out += ', ';
        out += key;
    }
    return out;
}

export interface EngineHookCallbacks {
    onInitHook?: (specPath: string, info: ModuleInfo) => void;
    onSyntaxError?: (e: SyntaxError) => never;
}

export interface EngineHooks {
    clearLoadedModules(): void;
}

function hasSyntaxSourceCause(error: SyntaxError): boolean {
    const cause = Reflect.get(error, 'cause');
    return !!cause && typeof cause === 'object' && Reflect.get(cause, 'source') instanceof SyntaxError;
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
        resolve(spec: string, parent: string, attr?: Record<string, unknown>): string {
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
            const meta: Record<string, unknown> = {};
            fillMeta(meta, info, resolver);

            const dedup = loadedModules.get(key);
            if (dedup) return dedup;

            try {
                const mod = compiler.load(info, meta);
                loadedModules.set(key, mod);
                return mod;
            } catch (e) {
                if (e instanceof SyntaxError && hasSyntaxSourceCause(e) && callbacks.onSyntaxError) {
                    callbacks.onSyntaxError(e);
                }
                throw e;
            }
        },

        init(specPath: string, importMeta: Record<string, unknown>): void {
            log.debug('runtime', () => `init hook: ${specPath}`);
            const info = resolver.getInfo(specPath);
            fillMeta(importMeta, info, resolver);
            callbacks.onInitHook?.(info.specPath, info);
        },

        attrchk(attr: Record<string, unknown>): void {
            const unknown = unknownAttrNames(attr);
            if (unknown) log.debug('runtime', () => `unknown attrs: ${unknown}`);
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
