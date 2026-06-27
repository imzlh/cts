// compile/wasm.ts — WASM compilation engine
//
// Handles .wasm module loading with circular dependency support
// (wasm-bindgen: JS glue imports from .wasm, .wasm imports table/memory from JS glue).

import type { ModuleInfo } from '../types';
import { buildWasmModule, type WasmImportSource } from '../wasm';
import { err, ErrorKind } from '../errors';
import { log } from '../utils/log';

const engine = import.meta.use('engine');

type LoadFn = (info: ModuleInfo, meta: Record<string, any>) => CModuleEngine.Module;
type ResolveFn = (spec: string, parent: string) => ModuleInfo;

export class WasmCompiler {
    private readonly wasmCache   = new Map<string, CModuleEngine.Module>();
    private readonly wasmLoading = new Set<string>();
    private readonly pendingWasm = new Map<string, Record<string, any>>();

    load(
        info: ModuleInfo,
        resolve: ResolveFn,
        loadModule: LoadFn,
    ): CModuleEngine.Module {
        const hit = this.wasmCache.get(info.localPath);
        if (hit) return hit;

        if (this.wasmLoading.has(info.localPath)) {
            // Circular dependency — return a placeholder that gains exports later
            log.debug('wasm', () => `cycle: ${info.specPath} -- returning placeholder`);
            const shared: Record<string, any> = {};
            const placeholder = engine.Module.create(info.specPath);
            placeholder.export('default', shared);
            this.wasmCache.set(info.localPath, placeholder);
            this.pendingWasm.set(info.localPath, shared);
            return placeholder;
        }

        this.wasmLoading.add(info.localPath);

        const importSource: WasmImportSource = {
            require: (spec: string, parentPath: string) => {
                const resolved = resolve(spec, parentPath);
                const loaded = loadModule(resolved, {});
                loaded.eval();
                const ns = loaded.namespace;
                log.debug('wasm', () => `import "${spec}" resolved -> ${resolved.specPath} (${Object.keys(ns).length} exports)`);
                return ns;
            },
        };

        const result = buildWasmModule(info, importSource);
        this.wasmLoading.delete(info.localPath);

        if (!result) throw err(ErrorKind.Generic, `WASM load failed: ${info.localPath}`);

        // Populate placeholder if one was created during circular resolution
        const pending = this.pendingWasm.get(info.localPath);
        if (pending) {
            const ns = result.mod.namespace;
            Object.assign(pending, ns);

            const placeholder = this.wasmCache.get(info.localPath)!;
            for (const key of Object.keys(ns)) {
                try { placeholder.export(key, ns[key]); } catch { /* ok */ }
            }

            this.pendingWasm.delete(info.localPath);
            log.debug('wasm', () => `populated placeholder: ${info.specPath} (${Object.keys(pending).length} exports)`);
            return placeholder;
        }

        this.wasmCache.set(info.localPath, result.mod);
        return result.mod;
    }

    clearCache(): void {
        this.wasmCache.clear();
    }

    hasPendingLoads(): boolean {
        return this.wasmLoading.size > 0;
    }
}
