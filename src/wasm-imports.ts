/** WASM import modules for the dep graph (host modules excluded). */

import { errMsg, log, readBytes } from './utils';

const wasm = import.meta.use('wasm');

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
export function scanWasmImportModules(bytes: Uint8Array, strict = false): string[] {
    if (!wasm) {
        if (strict) throw new Error('WASM import scanner is unavailable');
        return [];
    }
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
        if (strict) throw e;
        return [];
    }
}

export function scanWasmImportModulesFile(localPath: string, strict = false): string[] {
    try {
        return scanWasmImportModules(readBytes(localPath), strict);
    } catch (e) {
        log.debug('wasm', () => `import scan read failed ${localPath}: ${errMsg(e)}`);
        if (strict) throw e;
        return [];
    }
}
