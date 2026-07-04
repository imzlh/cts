// source/index.ts — Load layer: read files + TS/JSX to JS transform
//
// This layer is format-agnostic (no CJS/ESM awareness). It only:
//   1. Reads source files (disk / network cache)
//   2. Transforms (oxc native -> sucrase fallback -> passthrough)
//   3. Returns clean JS source

import type { ModuleInfo } from '../types';
import { moduleRef } from '../types';
import { readText, log } from '../utils';
import { Transformer } from './transform';

export { Transformer } from './transform';
export { JscCache, isRemote } from './cache';
export type { TransformerOptions } from './transform';

/**
 * Read and transform source code.
 * Applies oxc/sucrase for .ts/.tsx/.jsx; passes through .js/.json as-is.
 */
export function readSource(info: ModuleInfo, transformer: Transformer, lang?: string): string {
    const raw = readText(info.localPath);
    const code = transformer.transform(raw, info.localPath, lang, moduleRef(info));
    if (code !== raw) {
        log.debug('source', () => `transformed: ${info.localPath}`);
    }
    return code;
}

/**
 * Prepare source for CJS execution (strip TS/JSX syntax only, keep import/export intact).
 */
export function readSourceForCjs(info: ModuleInfo, transformer: Transformer, lang?: string): string {
    const raw = readText(info.localPath);
    return transformer.transformForCjs(raw, info.localPath, lang);
}
