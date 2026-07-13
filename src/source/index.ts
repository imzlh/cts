import type { ModuleInfo } from '../types';
import { moduleRef } from '../types';
import { readText, log } from '../utils';
import { Transformer } from './transform';

export { Transformer } from './transform';
export { JscCache, isRemote } from './cache';
export type { TransformerOptions } from './transform';

/** Read + transform (.ts/.tsx/.jsx); .js/.json passthrough. */
export function readSource(info: ModuleInfo, transformer: Transformer, lang?: string): string {
    const raw = readText(info.localPath);
    const code = transformer.transform(raw, info.localPath, lang, moduleRef(info));
    if (code !== raw) {
        log.debug('source', () => `transformed: ${info.localPath}`);
    }
    return code;
}

/** Strip TS/JSX for CJS; keep import/export intact. */
export function readSourceForCjs(info: ModuleInfo, transformer: Transformer, lang?: string): string {
    const raw = readText(info.localPath);
    return transformer.transformForCjs(raw, info.localPath, lang);
}
