// transformer.ts — TS/JSX → JS via Sucrase (no debug artifacts)

import { transform, type Transform, type Options } from '../deps/sucrase/src/index';
import { errMsg } from './utils/misc';
import { log } from './utils/log';
import { __use_fn } from './utils';

const smap    = __use_fn('sourcemap');

const BASE: Partial<Options> = { disableESTransforms: true, production: false };

export class Transformer {
    constructor(private readonly sourceMaps = true) {}

    transform(code: string, filename: string): string {
        if (code.startsWith('#!')) code = code.slice(code.indexOf('\n'));
        const ext = filename.slice(filename.lastIndexOf('.'));
        switch (ext) {
            case '.ts':   return this.run(code, filename, ['typescript']);
            case '.tsx':  return this.run(code, filename, ['typescript', 'jsx']);
            case '.jsx':  return this.run(code, filename, ['jsx']);
            case '.json': return `export default ${code};`;
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return code;
        }
    }

    private run(code: string, filename: string, transforms: Transform[]): string {
        try {
            const r = transform(code, { transforms, jsxPragma: 'React.createElement',
                jsxFragmentPragma: 'React.Fragment', filePath: filename, ...BASE });
            if (this.sourceMaps && r.sourceMap) {
                try { smap.load(filename, r.sourceMap); }
                catch (e) { log.warn('transformer', () => `smap: ${filename}`, e); }
            }
            return r.code;
        } catch (e) {
            throw new Error(`Transform failed (${filename}): ${errMsg(e)}`);
        }
    }
}
