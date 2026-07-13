/** WASM import modules for the dep graph (host modules excluded). */

import { errMsg, log } from './utils';

const wasm = import.meta.use('wasm');
const fs = import.meta.use('fs');

/** Host-only import module names (exact match; not path-like). */
const HOST_WASM_IMPORT_MODULES = new Set([
    'wasi_unstable',
    'wasi_snapshot_preview1',
    'env',
]);

export function isHostWasmImportModule(name: string): boolean {
    return HOST_WASM_IMPORT_MODULES.has(name);
}

/** Unique non-host import module names from a wasm binary. */
export function scanWasmImportModules(bytes: Uint8Array): string[] {
    if (!wasm) return [];
    try {
        const wmod = wasm.parseModule(bytes);
        const seen = new Set<string>();
        const out: string[] = [];
        for (const imp of wasm.moduleImports(wmod)) {
            if (isHostWasmImportModule(imp.module)) continue;
            if (seen.has(imp.module)) continue;
            seen.add(imp.module);
            out.push(imp.module);
        }
        return out;
    } catch (e) {
        log.debug('wasm', () => `import scan failed: ${errMsg(e)}`);
        return [];
    }
}

export function scanWasmImportModulesFile(localPath: string): string[] {
    try {
        return scanWasmImportModules(new Uint8Array(fs.readFile(localPath)));
    } catch (e) {
        log.debug('wasm', () => `import scan read failed ${localPath}: ${errMsg(e)}`);
        return [];
    }
}
