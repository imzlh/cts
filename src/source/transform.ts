// transformer.ts — TS/JSX → JS via oxc (native, fast) or Sucrase (fallback)

import { transform, type Transform, type Options } from '../../deps/sucrase/src/index';
import { errMsg, log } from '../utils';
import { err, ErrorKind, TransformError } from '../errors';
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

    transform(code: string, filename: string, lang?: string, mapKey?: string): string {
        if (code.startsWith('#!')) code = code.slice(code.indexOf('\n'));
        const ext = this.sourceExt(filename, lang);
        switch (ext) {
            case '.ts':
            case '.tsx':
            case '.jsx': {
                if (this.oxc) {
                    const result = this.oxc.transpile(code, filename, mapKey);
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return result;
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                const transforms: Transform[] = ext === '.jsx' ? ['jsx']
                    : ext === '.tsx' ? ['typescript', 'jsx']
                    : ['typescript'];
                return this.run(code, filename, transforms, mapKey);
            }
            case '.json': return `export default ${code};`;
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return code;
        }
    }

    /** Like transform(), but returns the sourcemap instead of registering it
     *  locally — for a caller whose JSContext (e.g. a worker) isn't the one
     *  that will run the compiled module. See Transformer.transform(). */
    transformCapture(code: string, filename: string, lang?: string, mapKey?: string): { code: string; sourceMap?: string | object } {
        if (code.startsWith('#!')) code = code.slice(code.indexOf('\n'));
        const ext = this.sourceExt(filename, lang);
        switch (ext) {
            case '.ts':
            case '.tsx':
            case '.jsx': {
                if (this.oxc) {
                    const result = this.oxc.transpileCapture(code, filename, mapKey);
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return this.sourceMaps ? result : { code: result.code };
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                const transforms: Transform[] = ext === '.jsx' ? ['jsx']
                    : ext === '.tsx' ? ['typescript', 'jsx']
                    : ['typescript'];
                return this.runCapture(code, filename, transforms, mapKey);
            }
            case '.json': return { code: `export default ${code};` };
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return { code };
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

    private run(code: string, filename: string, transforms: Transform[], mapKey?: string): string {
        try {
            const name = mapKey ?? filename;
            const r = transform(code, { transforms, jsxPragma: this.jsxPragma,
                jsxFragmentPragma: this.jsxFragmentPragma, filePath: name, ...BASE });
            if (this.sourceMaps && r.sourceMap) {
                try { smap.load(name, r.sourceMap); }
                catch (e) { log.warn('transformer', () => `smap: ${filename}`, e); }
            }
            return r.code;
        } catch (e) {
            throw this.toTransformError(e, filename);
        }
    }

    private runCapture(code: string, filename: string, transforms: Transform[], mapKey?: string): { code: string; sourceMap?: object } {
        try {
            const r = transform(code, { transforms, jsxPragma: this.jsxPragma,
                jsxFragmentPragma: this.jsxFragmentPragma, filePath: mapKey ?? filename, ...BASE });
            return { code: r.code, sourceMap: this.sourceMaps ? r.sourceMap : undefined };
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
