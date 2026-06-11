// transformer.ts — TS/JSX → JS via Sucrase (no debug artifacts)

import { transform, type Transform, type Options } from '../deps/sucrase/src/index';
import { errMsg } from './utils/misc';
import { err, ErrorKind, TransformError } from './errors';
import { log } from './utils/log';
import { __use_fn } from './utils';

const smap    = __use_fn('sourcemap');

const BASE: Partial<Options> = { disableESTransforms: true, production: false };

export interface TransformerOptions {
    sourceMaps?: boolean;
    jsxPragma?: string;
    jsxFragmentPragma?: string;
}

export class Transformer {
    private readonly sourceMaps: boolean;
    private readonly jsxPragma: string;
    private readonly jsxFragmentPragma: string;

    constructor(options: TransformerOptions = {}) {
        this.sourceMaps = options.sourceMaps ?? true;
        this.jsxPragma = options.jsxPragma ?? 'React.createElement';
        this.jsxFragmentPragma = options.jsxFragmentPragma ?? 'React.Fragment';
    }

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
            const r = transform(code, { transforms, jsxPragma: this.jsxPragma,
                jsxFragmentPragma: this.jsxFragmentPragma, filePath: filename, ...BASE });
            if (this.sourceMaps && r.sourceMap) {
                try { smap.load(filename, r.sourceMap); }
                catch (e) { log.warn('transformer', () => `smap: ${filename}`, e); }
            }
            return r.code;
        } catch (e) {
            throw this.toTransformError(e, filename);
        }
    }

    private toTransformError(error: unknown, filename: string): Error {
        const message = errMsg(error);
        const match = message.match(/\((\d+):(\d+)\)\s*$/);
        const clean = message
            .replace(/^Error transforming .+?:\s*/, '')
            .replace(/\s*\(\d+:\d+\)\s*$/, '')
            .trim();
        if (!match) {
            return err(ErrorKind.TransformError, `Transform failed (${filename}): ${clean}`);
        }
        return new TransformError(clean, filename, Number(match[1]), Number(match[2]));
    }
}
