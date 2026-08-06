import { transformCnoCode } from '../../deps/sucrase/src/index';
import { errMsg, log } from '../utils';
import { err, ErrorKind, TransformError } from '../errors';
import type { OxcTranspiler } from '../oxc';

const engine = import.meta.use('engine');
const smap = import.meta.use('sourcemap');

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
    private oxcLoader: (() => OxcTranspiler | null) | null = null;
    private oxcLoaded = false;

    constructor(options: TransformerOptions = {}) {
        this.sourceMaps = options.sourceMaps ?? true;
        this.jsxPragma = options.jsxPragma ?? 'React.createElement';
        this.jsxFragmentPragma = options.jsxFragmentPragma ?? 'React.Fragment';
    }

    /** Install the native oxc transpiler. When set, it takes priority over Sucrase. */
    setOxc(oxc: OxcTranspiler): void {
        this.oxc = oxc;
        this.oxcLoaded = true;
    }

    /** Defer native extension loading until a TS/TSX/JSX transform misses bytecode. */
    setOxcLoader(loader: () => OxcTranspiler | null): void {
        this.oxcLoader = loader;
    }

    private getOxc(): OxcTranspiler | null {
        if (!this.oxcLoaded) {
            this.oxcLoaded = true;
            this.oxc = this.oxcLoader?.() ?? null;
        }
        return this.oxc;
    }

    transform(code: string, filename: string, lang?: string, mapKey?: string): string {
        code = stripShebang(code);
        const kind = sourceKind(filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JSX: {
                const oxc = this.getOxc();
                if (oxc) {
                    const result = oxc.transpile(code, filename, mapKey, oxcLang(kind));
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return result;
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                // .cts keeps TS strip + unused imports (CJS require/exports intact).
                return this.run(
                    code, filename,
                    kind !== KIND_JSX,
                    kind === KIND_TSX || kind === KIND_JSX,
                    mapKey,
                    kind === KIND_CTS,
                );
            }
            case KIND_JSON: return `export default ${code};`;
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return code;
        }
    }

    /** Like transform(); return sourcemap for remote JSContext. */
    transformCapture(code: string, filename: string, lang?: string, mapKey?: string): { code: string; sourceMap?: string | object } {
        code = stripShebang(code);
        const kind = sourceKind(filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JSX: {
                const oxc = this.getOxc();
                if (oxc) {
                    const result = oxc.transpileCapture(code, filename, mapKey, oxcLang(kind));
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return this.sourceMaps ? result : { code: result.code };
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                return this.runCapture(
                    code, filename,
                    kind !== KIND_JSX,
                    kind === KIND_TSX || kind === KIND_JSX,
                    mapKey,
                );
            }
            case KIND_JSON: return { code: `export default ${code};` };
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return { code };
        }
    }

    transformCaptureBytes(bytes: Uint8Array, filename: string, lang?: string, mapKey?: string): { code: string | Uint8Array; sourceMap?: string | Uint8Array | object } | null {
        const kind = sourceKind(filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JSX:
                if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) return null;
                const oxc = this.getOxc();
                if (!oxc) return null;
                const result = oxc.transpileBytes(bytes, filename, mapKey, oxcLang(kind));
                if (result !== null) {
                    log.debug('transformer', () => `oxc bytes: ${filename}`);
                    return this.sourceMaps ? result : { code: result.code };
                }
                rejectNonUtf8(bytes, filename);
                return null;
            default:
                return null;
        }
    }

    /** transform from file bytes; prefer no JS string. Sucrase/shebang fall back. */
    transformBytes(bytes: Uint8Array, filename: string, lang?: string, mapKey?: string): string | Uint8Array {
        const kind = sourceKind(filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JSX: {
                if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) {
                    return this.transform(engine.decodeString(bytes), filename, lang, mapKey);
                }
                const oxc = this.getOxc();
                if (oxc) {
                    const result = oxc.transpileBytes(bytes, filename, mapKey, oxcLang(kind));
                    if (result !== null) {
                        log.debug('transformer', () => `oxc bytes: ${filename}`);
                        if (this.sourceMaps && result.sourceMap) {
                            this.registerSourceMap(mapKey ?? filename, result.sourceMap);
                        }
                        return result.code;
                    }
                    rejectNonUtf8(bytes, filename);
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                return this.run(
                    engine.decodeString(bytes), filename,
                    kind !== KIND_JSX,
                    kind === KIND_TSX || kind === KIND_JSX,
                    mapKey,
                    kind === KIND_CTS,
                );
            }
            case KIND_JSON: return `export default ${engine.decodeString(bytes)};`;
            default:
                log.debug('transformer', () => `passthrough bytes: ${filename}`);
                return bytes;
        }
    }

    private registerSourceMap(name: string, sourceMap: string | Uint8Array): void {
        try {
            if (sourceMap instanceof Uint8Array) smap.loadJSONBytes(name, sourceMap);
            else smap.loadJSON(name, sourceMap);
        } catch (e) {
            log.debug('transformer', () => `smap: ${name}: ${errMsg(e)}`);
        }
    }

    /** Strip TS/JSX for CJS; does not rewrite ESM import/export. */
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

export function isPassthroughSource(filename: string): boolean {
    const kind = sourceKind(filename);
    // .cts needs TS strip (transformForCjs / transform); not plain JS passthrough.
    return kind !== KIND_TS && kind !== KIND_CTS && kind !== KIND_TSX
        && kind !== KIND_JSX && kind !== KIND_JSON;
}

function sourceKind(filename: string, lang?: string): number {
    if (lang) {
        switch (lang) {
            case 'ts':
            case 'mts': return KIND_TS;
            case 'tsx': return KIND_TSX;
            case 'jsx': return KIND_JSX;
            case 'cts': return KIND_CTS;
            case 'json': return KIND_JSON;
            default: return KIND_OTHER;
        }
    }
    // Pack module local paths retain query/hash identity suffixes. They are
    // not part of the language extension used by the fallback transformer.
    const length = sourcePathLength(filename);
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

function sourcePathLength(filename: string): number {
    if (!filename.startsWith('pack:')) return filename.length;
    const query = filename.indexOf('?');
    const hash = filename.indexOf('#');
    if (query === -1) return hash === -1 ? filename.length : hash;
    return hash === -1 ? query : Math.min(query, hash);
}

function oxcLang(kind: number): string {
    switch (kind) {
        case KIND_TS:
        case KIND_CTS: return 'ts';
        case KIND_TSX: return 'tsx';
        case KIND_JSX: return 'jsx';
        default: return 'js';
    }
}

function stripShebang(code: string): string {
    if (code.length < 2 || code.charCodeAt(0) !== 35 || code.charCodeAt(1) !== 33) {
        return code;
    }
    const newlineIndex = code.indexOf('\n');
    return newlineIndex === -1 ? '' : code.slice(newlineIndex);
}

/**
 * Throw a located TransformError when `bytes` is not valid UTF-8.
 *
 * Called only on the oxc-declined path, so well-formed sources are unaffected.
 */
function rejectNonUtf8(bytes: Uint8Array, filename: string): void {
    const bad = firstInvalidUtf8(bytes);
    if (bad < 0) return;
    let line = 1;
    let column = 0;
    for (let i = 0; i < bad; i++) {
        if (bytes[i] === 10) { line++; column = 0; } else { column++; }
    }
    const hex = bytes[bad].toString(16).padStart(2, '0');
    throw new TransformError(
        `source is not valid UTF-8 (byte 0x${hex} at offset ${bad}); `
        + 'save the file as UTF-8',
        filename, line, column,
    );
}

/**
 * Byte offset of the first invalid UTF-8 sequence, or -1 when the input is
 * well-formed.
 *
 * Exported for direct unit testing: the call sites below only reach this when
 * oxc has already declined, so a false positive here (flagging valid UTF-8)
 * would silently convert a working Sucrase fallback into a hard error, and
 * end-to-end tests cannot observe that. Test it directly instead.
 *
 * The native oxc transpiler rejects non-UTF-8 input outright
 * (`std::str::from_utf8` in ext-oxc/src/lib.rs), and OxcTranspiler collapses
 * that failure into `null` — indistinguishable from "oxc declined". Falling
 * back to Sucrase on such a file is not safe: Sucrase silently erases
 * `namespace` bodies and decorated classes, so a single stray byte turns into
 * wrong runtime behaviour with exit code 0. Detect the condition here and
 * fail loudly instead.
 */
export function firstInvalidUtf8(bytes: Uint8Array): number {
    const len = bytes.byteLength;
    let i = 0;
    while (i < len) {
        const b = bytes[i];
        if (b < 0x80) { i++; continue; }
        let need: number;
        let min: number;
        if (b >= 0xc2 && b <= 0xdf) { need = 1; min = 0x80; }
        else if (b >= 0xe0 && b <= 0xef) { need = 2; min = 0x800; }
        else if (b >= 0xf0 && b <= 0xf4) { need = 3; min = 0x10000; }
        else return i; // 0x80-0xc1 continuation/overlong lead, or 0xf5-0xff
        if (i + need > len - 1) return i;                // truncated sequence
        let cp = b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
        for (let k = 1; k <= need; k++) {
            const c = bytes[i + k];
            if ((c & 0xc0) !== 0x80) return i;
            cp = (cp << 6) | (c & 0x3f);
        }
        if (cp < min) return i;                          // overlong
        if (cp >= 0xd800 && cp <= 0xdfff) return i;      // surrogate half
        if (cp > 0x10ffff) return i;                     // out of range
        i += need + 1;
    }
    return -1;
}
