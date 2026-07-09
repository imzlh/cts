// transformer.ts — TS/JSX → JS via oxc (native, fast) or Sucrase (fallback)

import { transformCnoCode } from '../../deps/sucrase/src/index';
import { errMsg, log } from '../utils';
import { err, ErrorKind, TransformError } from '../errors';
import type { OxcTranspiler } from '../oxc';

const KIND_OTHER = 0;
const KIND_TS = 1;
const KIND_TSX = 2;
const KIND_JSX = 3;
const KIND_CTS = 4;
const KIND_JSON = 5;

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
        code = stripShebang(code);
        const kind = sourceKind(filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_TSX:
            case KIND_JSX: {
                if (this.oxc) {
                    const result = this.oxc.transpile(code, filename, mapKey);
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return result;
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                return this.run(code, filename, kind !== KIND_JSX, kind !== KIND_TS, mapKey);
            }
            case KIND_JSON: return `export default ${code};`;
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return code;
        }
    }

    /** Like transform(), but returns the sourcemap instead of registering it
     *  locally — for a caller whose JSContext (e.g. a worker) isn't the one
     *  that will run the compiled module. See Transformer.transform(). */
    transformCapture(code: string, filename: string, lang?: string, mapKey?: string): { code: string; sourceMap?: string | object } {
        code = stripShebang(code);
        const kind = sourceKind(filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_TSX:
            case KIND_JSX: {
                if (this.oxc) {
                    const result = this.oxc.transpileCapture(code, filename, mapKey);
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return this.sourceMaps ? result : { code: result.code };
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                return this.runCapture(code, filename, kind !== KIND_JSX, kind !== KIND_TS, mapKey);
            }
            case KIND_JSON: return { code: `export default ${code};` };
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return { code };
        }
    }

    transformCaptureBytes(bytes: Uint8Array, filename: string, lang?: string, mapKey?: string): { code: string; sourceMap?: string | object } | null {
        const kind = sourceKind(filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_TSX:
            case KIND_JSX:
                if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) return null;
                if (!this.oxc) return null;
                const result = this.oxc.transpileBytes(bytes, filename, mapKey);
                if (result !== null) {
                    log.debug('transformer', () => `oxc bytes: ${filename}`);
                    return this.sourceMaps ? result : { code: result.code };
                }
                return null;
            default:
                return null;
        }
    }

    /**
     * Prepare source for CommonJS execution.
     * This only strips TS/JSX syntax from files already classified as CJS;
     * it does not rewrite ESM import/export semantics.
     */
    transformForCjs(code: string, filename: string, lang?: string): string {
        code = stripShebang(code);
        switch (sourceKind(filename, lang)) {
            case KIND_TS:
            case KIND_CTS:
                return this.run(code, filename, true, false, undefined, true);
            case KIND_TSX:
                return this.run(code, filename, true, true, undefined, true);
            case KIND_JSX:
                return this.run(code, filename, false, true);
            default:
                log.debug('transformer', () => `cjs passthrough: ${filename}`);
                return code;
        }
    }

    private run(
        code: string,
        filename: string,
        isTypeScriptEnabled: boolean,
        isJSXEnabled: boolean,
        mapKey?: string,
        keepUnusedImports = false,
    ): string {
        try {
            const name = mapKey ?? filename;
            return transformCnoCode(
                code,
                name,
                isTypeScriptEnabled,
                isJSXEnabled,
                this.jsxPragma,
                this.jsxFragmentPragma,
                keepUnusedImports,
            );
        } catch (e) {
            throw this.toTransformError(e, filename);
        }
    }

    private runCapture(
        code: string,
        filename: string,
        isTypeScriptEnabled: boolean,
        isJSXEnabled: boolean,
        mapKey?: string,
    ): { code: string; sourceMap?: object } {
        try {
            const codeOut = transformCnoCode(
                code,
                mapKey ?? filename,
                isTypeScriptEnabled,
                isJSXEnabled,
                this.jsxPragma,
                this.jsxFragmentPragma,
            );
            return { code: codeOut };
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

function sourceKind(filename: string, lang?: string): number {
    if (lang) {
        switch (lang) {
            case 'ts': return KIND_TS;
            case 'tsx': return KIND_TSX;
            case 'jsx': return KIND_JSX;
            case 'cts': return KIND_CTS;
            case 'json': return KIND_JSON;
            default: return KIND_OTHER;
        }
    }
    const length = filename.length;
    if (length < 3) return KIND_OTHER;
    const last = filename.charCodeAt(length - 1);
    if (last === 115) {
        if (filename.charCodeAt(length - 2) !== 116) return KIND_OTHER;
        const third = filename.charCodeAt(length - 3);
        if (third === 46) return KIND_TS;
        if (third === 109 && length >= 4 && filename.charCodeAt(length - 4) === 46) {
            return KIND_TS;
        }
        if (third === 99 && length >= 4 && filename.charCodeAt(length - 4) === 46) {
            return KIND_CTS;
        }
        return KIND_OTHER;
    }
    if (last === 120 && length >= 4) {
        const third = filename.charCodeAt(length - 3);
        if (filename.charCodeAt(length - 2) !== 115 ||
            filename.charCodeAt(length - 4) !== 46) {
            return KIND_OTHER;
        }
        if (third === 116) return KIND_TSX;
        if (third === 106) return KIND_JSX;
        return KIND_OTHER;
    }
    if (last === 110 && length >= 5 &&
        filename.charCodeAt(length - 2) === 111 &&
        filename.charCodeAt(length - 3) === 115 &&
        filename.charCodeAt(length - 4) === 106 &&
        filename.charCodeAt(length - 5) === 46) {
        return KIND_JSON;
    }
    return KIND_OTHER;
}

function stripShebang(code: string): string {
    if (code.length < 2 || code.charCodeAt(0) !== 35 || code.charCodeAt(1) !== 33) {
        return code;
    }
    const newlineIndex = code.indexOf('\n');
    return newlineIndex === -1 ? '' : code.slice(newlineIndex);
}
