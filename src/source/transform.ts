// transformer.ts — TS/JSX → JS via oxc (native, fast) or Sucrase (fallback)

import { transform, type Transform, type Options } from '../../deps/sucrase/src/index';
import { errMsg } from '../utils/misc';
import { err, ErrorKind, TransformError } from '../errors';
import { log } from '../utils/log';
import type { OxcTranspiler } from '../oxc';

const smap = import.meta.use('sourcemap');

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
    private oxc: OxcTranspiler | null = null;

    constructor(options: TransformerOptions = {}) {
        this.sourceMaps = options.sourceMaps ?? true;
        this.jsxPragma = options.jsxPragma ?? 'React.createElement';
        this.jsxFragmentPragma = options.jsxFragmentPragma ?? 'React.Fragment';
    }

    /** Install the native oxc transpiler. When set, it takes priority over Sucrase. */
    setOxc(oxc: OxcTranspiler): void {
        this.oxc = oxc;
    }

    transform(code: string, filename: string, lang?: string): string {
        if (code.startsWith('#!')) code = code.slice(code.indexOf('\n'));
        const ext = this.sourceExt(filename, lang);
        switch (ext) {
            case '.ts':
            case '.tsx':
            case '.jsx': {
                if (this.oxc) {
                    const result = this.oxc.transpile(code, filename);
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return result;
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                const transforms: Transform[] = ext === '.jsx' ? ['jsx']
                    : ext === '.tsx' ? ['typescript', 'jsx']
                    : ['typescript'];
                return this.run(code, filename, transforms);
            }
            case '.json': return `export default ${code};`;
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return code;
        }
    }

    /**
     * Prepare source for CommonJS execution.
     * This only strips TS/JSX syntax from files already classified as CJS;
     * it does not rewrite ESM import/export semantics.
     */
    transformForCjs(code: string, filename: string, lang?: string): string {
        if (code.startsWith('#!')) code = code.slice(code.indexOf('\n'));
        const ext = this.sourceExt(filename, lang);
        switch (ext) {
            case '.ts':
            case '.cts':
                return this.run(code, filename, ['typescript']);
            case '.tsx':
                return this.run(code, filename, ['typescript', 'jsx']);
            case '.jsx':
                return this.run(code, filename, ['jsx']);
            default:
                log.debug('transformer', () => `cjs passthrough: ${filename}`);
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

    private sourceExt(filename: string, lang?: string): string {
        return lang ? `.${lang}` : filename.slice(filename.lastIndexOf('.'));
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
