import { transformCnoCode } from '../../deps/sucrase/src/cno';
import { dirname, joinPaths, hasSchemeId, isAbsolute, normalizePath, toPosixPath, readText, errMsg, log } from '../utils';
import { err, ErrorKind, TransformError } from '../errors';
import type { OxcTranspiler } from '../oxc';
import { decodeStringToken, extractImports } from '../scan';
import { parse } from '../../deps/sucrase/src/parser';
import { TokenType } from '../../deps/sucrase/src/parser/tokenizer/types';

const engine = import.meta.use('engine');
const smap = import.meta.use('sourcemap');
const algorithm = import.meta.use('algorithm');

const KIND_OTHER = 0;
const KIND_TS = 1;
const KIND_TSX = 2;
const KIND_JSX = 3;
const KIND_CTS = 4;
const KIND_JSON = 5;
const KIND_JS_TRANSFORM = 6;
const BUNDLE_SPECIFIER = 'bun:bundle';
const BUNDLE_SPECIFIER_BYTES = engine.encodeString('bun:bundle');
const ESCAPE_BYTE = new Uint8Array([92]);
const DECORATOR_BYTE = new Uint8Array([64]);

export interface TransformerOptions {
    sourceMaps?: boolean;
    /** Honor `//# sourceMappingURL` annotations in passthrough (untranspiled) sources. */
    inlineSourceMaps?: boolean;
    jsxPragma?: string;
    jsxFragmentPragma?: string;
}

export class Transformer {
    private readonly sourceMaps: boolean;
    private readonly inlineSourceMaps: boolean;
    private readonly jsxPragma: string;
    private readonly jsxFragmentPragma: string;
    private oxc: OxcTranspiler | null = null;
    private oxcLoader: (() => OxcTranspiler | null) | null = null;
    private oxcLoaded = false;
    /** Modules whose runtime source map was registered; consumed by the bytecode persist gate. */
    private readonly runtimeMappedKeys = new Set<string>();

    constructor(options: TransformerOptions = {}) {
        this.sourceMaps = options.sourceMaps ?? true;
        this.inlineSourceMaps = options.inlineSourceMaps ?? false;
        this.jsxPragma = options.jsxPragma ?? 'React.createElement';
        this.jsxFragmentPragma = options.jsxFragmentPragma ?? 'React.Fragment';
    }

    /**
     * Consume the runtime-map marker for a module. A persisted .jsc cannot be
     * re-injected from (the map lives in the runtime, not the bytecode), so
     * mapped modules must stay source-cached to keep stacks remapped.
     *
     * The method name is retained for the existing CJS bridge contract.
     */
    tookInlineSourceMap(moduleKey: string): boolean {
        return this.runtimeMappedKeys.delete(moduleKey);
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
        const kind = transformKind(code, filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JS_TRANSFORM:
            case KIND_JSX: {
                const oxc = this.getOxc();
                if (oxc) {
                    const result = oxc.transpileCapture(code, filename, mapKey, oxcLang(kind), false);
                    if (result !== null) {
                        if (this.sourceMaps && result.sourceMap) {
                            this.registerSourceMap(mapKey ?? filename, result.sourceMap);
                        }
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return result.code;
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                rejectNativeTransformFallback(code, filename, kind);
                // .cts keeps TS strip + unused imports (CJS require/exports intact).
                return this.run(
                    code, filename,
                    kind !== KIND_JSX && kind !== KIND_JS_TRANSFORM,
                    kind === KIND_TSX || kind === KIND_JSX,
                    mapKey,
                    kind === KIND_CTS,
                );
            }
            case KIND_JSON: return `export default ${code};`;
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                // No inline-map load here: string inputs (stdin/eval entries)
                // have no file to resolve an annotation against. TS-family
                // shebang sources pre-load in transformBytes; passthrough
                // shebang sources load via the bytes-tail path.
                return code;
        }
    }

    /** Like transform(); return sourcemap for remote JSContext. */
    transformCapture(code: string, filename: string, lang?: string, mapKey?: string): { code: string; sourceMap?: string | object } {
        code = stripShebang(code);
        const kind = transformKind(code, filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JS_TRANSFORM:
            case KIND_JSX: {
                const oxc = this.getOxc();
                if (oxc) {
                    const result = oxc.transpileCapture(code, filename, mapKey, oxcLang(kind), false);
                    if (result !== null) {
                        log.debug('transformer', () => `oxc: ${filename}`);
                        return this.sourceMaps ? result : { code: result.code };
                    }
                    log.debug('transformer', () => `oxc fallback to sucrase: ${filename}`);
                }
                rejectNativeTransformFallback(code, filename, kind);
                return {
                    code: this.run(
                        code, filename,
                        kind !== KIND_JSX && kind !== KIND_JS_TRANSFORM,
                        kind === KIND_TSX || kind === KIND_JSX,
                        mapKey,
                        kind === KIND_CTS,
                    ),
                };
            }
            case KIND_JSON: return { code: `export default ${code};` };
            default:
                log.debug('transformer', () => `passthrough: ${filename}`);
                return { code };
        }
    }

    transformCaptureBytes(bytes: Uint8Array, filename: string, lang?: string, mapKey?: string): { code: string | Uint8Array; sourceMap?: string | Uint8Array | object } | null {
        const kind = transformKind(bytes, filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JS_TRANSFORM:
            case KIND_JSX:
                if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) return null;
                const oxc = this.getOxc();
                if (!oxc) return null;
                const result = oxc.transpileBytes(bytes, filename, mapKey, oxcLang(kind), false);
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
        const kind = transformKind(bytes, filename, lang);
        switch (kind) {
            case KIND_TS:
            case KIND_CTS:
            case KIND_TSX:
            case KIND_JS_TRANSFORM:
            case KIND_JSX: {
                if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) {
                    const decoded = engine.decodeString(bytes);
                    // Pre-load before delegating: transform() must not load
                    // (string path), but this module is file-backed and will
                    // reach the bytecode persist gate.
                    this.loadInlineSourceMap(mapKey ?? filename, filename, decoded);
                    return this.transform(decoded, filename, lang, mapKey);
                }
                const oxc = this.getOxc();
                if (oxc) {
                    const result = oxc.transpileBytes(bytes, filename, mapKey, oxcLang(kind), false);
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
                const decoded = engine.decodeString(bytes);
                rejectNativeTransformFallback(decoded, filename, kind);
                return this.run(
                    decoded, filename,
                    kind !== KIND_JSX && kind !== KIND_JS_TRANSFORM,
                    kind === KIND_TSX || kind === KIND_JSX,
                    mapKey,
                    kind === KIND_CTS,
                );
            }
            case KIND_JSON: return `export default ${engine.decodeString(bytes)};`;
            default: {
                log.debug('transformer', () => `passthrough bytes: ${filename}`);
                this.loadInlineSourceMapBytes(mapKey ?? filename, filename, bytes);
                if (bytes.byteLength >= 2 && bytes[0] === 35 && bytes[1] === 33) {
                    // QuickJS receives passthrough bytes directly, so the
                    // string transform's shebang handling is otherwise
                    // bypassed for plain .js and extensionless entries.
                    return stripShebang(engine.decodeString(bytes));
                }
                return bytes;
            }
        }
    }

    private registerSourceMap(name: string, sourceMap: string | Uint8Array): void {
        try {
            smap.load(name, sourceMap);
            this.runtimeMappedKeys.add(name);
        } catch (e) {
            log.debug('transformer', () => `smap: ${name}: ${errMsg(e)}`);
        }
    }

    /**
     * Load a passthrough module's embedded sourceMappingURL map into the
     * native runtime. Transpiled sources do not need this: oxc/Sucrase inject
     * their maps under the same key. Opt-in because it costs one stat + read
     * + JSON parse per annotated file.
     */
    loadInlineSourceMap(moduleKey: string, localPath: string, code: string, track = true): void {
        if (!this.inlineSourceMaps) return;
        const url = embeddedSourceMapUrl(code);
        if (url !== undefined) this.loadResolvedInlineSourceMap(moduleKey, localPath, url, track);
    }

    /** Byte variant: only the tail is decoded, so multi-MB bundles stay cheap. */
    private loadInlineSourceMapBytes(moduleKey: string, localPath: string, bytes: Uint8Array): void {
        if (!this.inlineSourceMaps || bytes.byteLength === 0) return;
        const windowStart = Math.max(0, bytes.byteLength - INLINE_SOURCEMAP_TAIL_BYTES);
        const url = embeddedSourceMapUrlFromTail(engine.decodeString(bytes.subarray(windowStart)));
        if (url !== undefined) this.loadResolvedInlineSourceMap(moduleKey, localPath, url, true);
    }

    private loadResolvedInlineSourceMap(moduleKey: string, localPath: string, url: string, track: boolean): void {
        if (hasSchemeId(url)) {
            log.debug('transformer', () => `smap: ${moduleKey}: data URI / URL maps are not loaded`);
            return;
        }
        const posix = toPosixPath(url);
        const mapPath = isAbsolute(posix) ? normalizePath(posix) : joinPaths(dirname(localPath), posix);
        try {
            smap.load(moduleKey, readText(mapPath));
            if (track) this.runtimeMappedKeys.add(moduleKey);
            log.debug('transformer', () => `smap: inline map loaded for ${moduleKey}`);
        } catch (e) {
            log.debug('transformer', () => `smap: ${moduleKey}: ${errMsg(e)}`);
        }
    }

    /** Strip TS/JSX for CJS; does not rewrite ESM import/export. */
    transformForCjs(code: string, filename: string, lang?: string, mapKey?: string): string {
        code = stripShebang(code);
        switch (sourceKind(filename, lang)) {
            case KIND_TS:
            case KIND_CTS:
                code = this.run(code, filename, true, false, mapKey, true);
                break;
            case KIND_TSX:
                code = this.run(code, filename, true, true, mapKey, true);
                break;
            case KIND_JSX:
                code = this.run(code, filename, false, true, mapKey);
                break;
            default:
                log.debug('transformer', () => `cjs passthrough: ${filename}`);
                this.loadInlineSourceMap(mapKey ?? filename, filename, code);
        }
        const bundleFeature = hasBundleFeatureImport(code, false);
        const decorators = hasDecoratorSyntax(code, false);
        if (!bundleFeature && !decorators) return code;
        const lowered = this.getOxc()?.transpileCapture(code, filename, mapKey, 'js', true);
        if (lowered !== undefined && lowered !== null) {
            if (this.sourceMaps && lowered.sourceMap) {
                this.registerSourceMap(mapKey ?? filename, lowered.sourceMap);
            }
            return lowered.code;
        }
        rejectNativeTransformFallback(code, filename, KIND_JS_TRANSFORM);
        return code;
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

/**
 * Extract the sourceMappingURL from the complete last source line. String
 * callers already own the source, so retaining a long data URL or path here is
 * cheap and avoids silently truncating a valid annotation. Byte callers keep
 * their bounded tail scan below so multi-MB files are not decoded wholesale.
 */
function embeddedSourceMapUrl(code: string): string | undefined {
    let end = code.length;
    while (end > 0) {
        const ch = code.charCodeAt(end - 1);
        if (ch !== 10 && ch !== 13 && ch !== 32 && ch !== 9) break;
        end--;
    }
    const lineStart = Math.max(code.lastIndexOf('\n', end - 1), code.lastIndexOf('\r', end - 1)) + 1;
    return matchSourceMapAnnotation(code.slice(lineStart, end), lineStart === 0);
}

const INLINE_SOURCEMAP_TAIL_BYTES = 4096;

/**
 * Tail variant for byte pipelines. When the window begins mid-line
 * (lineStart === 0) the full-line match is unavailable, so the annotation is
 * matched end-anchored instead — minified single-line bundles end with it
 * glued after code.
 */
function embeddedSourceMapUrlFromTail(tail: string): string | undefined {
    let end = tail.length;
    while (end > 0) {
        const ch = tail.charCodeAt(end - 1);
        if (ch !== 10 && ch !== 13 && ch !== 32 && ch !== 9) break;
        end--;
    }
    const lineStart = Math.max(tail.lastIndexOf('\n', end - 1), tail.lastIndexOf('\r', end - 1)) + 1;
    return matchSourceMapAnnotation(tail.slice(lineStart, end), lineStart === 0);
}

/** Full-line first; end-anchored only where the line start is provably present. */
const SOURCEMAP_FULL_LINE = /^[\t ]*\/\/[#@][\t ]*sourceMappingURL=([^\s]+)[\t ]*$/;
const SOURCEMAP_END_ANCHORED = /\/\/[#@][\t ]*sourceMappingURL=([^\s]+)[\t ]*$/;

function matchSourceMapAnnotation(line: string, mayBeTruncatedHead: boolean): string | undefined {
    const fullLine = SOURCEMAP_FULL_LINE.exec(line);
    if (fullLine) return fullLine[1];
    if (mayBeTruncatedHead) {
        const endAnchored = SOURCEMAP_END_ANCHORED.exec(line);
        if (endAnchored) return endAnchored[1];
    }
    return undefined;
}

/** Public gate for the bytecode caches: annotated passthrough modules must
 *  stay source-cached, because their map lives in the runtime, not in .jsc. */
export function hasEmbeddedSourceMap(text: string): boolean {
    return embeddedSourceMapUrl(text) !== undefined;
}

export function hasEmbeddedSourceMapBytes(bytes: Uint8Array): boolean {
    if (bytes.byteLength === 0) return false;
    const windowStart = Math.max(0, bytes.byteLength - INLINE_SOURCEMAP_TAIL_BYTES);
    return embeddedSourceMapUrlFromTail(engine.decodeString(bytes.subarray(windowStart))) !== undefined;
}

function transformKind(source: string | Uint8Array, filename: string, lang?: string): number {
    const kind = sourceKind(filename, lang);
    if (kind !== KIND_OTHER) return kind;
    return hasBundleFeatureImport(source, false) || hasDecoratorSyntax(source, false)
        ? KIND_JS_TRANSFORM : kind;
}

function rejectNativeTransformFallback(
    source: string,
    filename: string,
    kind: number,
): void {
    const isTypeScript = kind === KIND_TS || kind === KIND_TSX || kind === KIND_CTS;
    const isJSXEnabled = kind === KIND_TSX || kind === KIND_JSX || kind === KIND_JS_TRANSFORM;
    if (hasBundleFeatureImport(source, isTypeScript)) {
        throw err(ErrorKind.TransformError, `${filename}: bun:bundle requires native OXC transformation`);
    }
    if (hasDecoratorSyntax(source, isTypeScript, isJSXEnabled)) {
        throw err(ErrorKind.TransformError, `${filename}: standard decorators require native OXC transformation`);
    }
}

function hasDecoratorSyntax(source: string | Uint8Array, isTypeScript: boolean, isJSXEnabled = true): boolean {
    const candidate = typeof source === 'string'
        ? source.includes('@')
        : algorithm.bytesIndexOf(source, DECORATOR_BYTE) !== -1;
    if (!candidate) return false;
    const text = typeof source === 'string' ? source : engine.decodeString(source);
    try {
        return parse(text, isJSXEnabled, isTypeScript, false).tokens.some(token => token.type === TokenType.at);
    } catch {
        // Feature detection must not replace the normal transform diagnostic.
        return false;
    }
}

function hasBundleFeatureImport(source: string | Uint8Array, isTypeScript: boolean): boolean {
    const hasRawSpecifier = typeof source === 'string'
        ? source.includes(BUNDLE_SPECIFIER)
        : algorithm.bytesIndexOf(source, BUNDLE_SPECIFIER_BYTES) !== -1;
    if (!hasRawSpecifier) {
        const hasEscape = typeof source === 'string'
            ? source.includes('\\')
            : algorithm.bytesIndexOf(source, ESCAPE_BYTE) !== -1;
        if (!hasEscape || !hasEscapedBundleLiteral(source)) return false;
    }
    const text = typeof source === 'string' ? source : engine.decodeString(source);
    try {
        return extractImports(text, isTypeScript, true, { includeTypeOnlyImports: true })
            .includes(BUNDLE_SPECIFIER);
    } catch {
        // Leave malformed imports to OXC/Sucrase so they retain file diagnostics.
        return false;
    }
}

function hasEscapedBundleLiteral(source: string | Uint8Array): boolean {
    for (let index = 0; index < source.length; index++) {
        const quote = codeAt(source, index);
        if ((quote !== 34 && quote !== 39) ||
            (codeAt(source, index + 1) !== 98 && codeAt(source, index + 1) !== 92)) continue;

        let end = index + 1;
        let hasEscape = false;
        while (end < source.length && end - index <= 128) {
            const code = codeAt(source, end);
            if (code === quote) {
                if (hasEscape) {
                    const token = typeof source === 'string'
                        ? source.slice(index, end + 1)
                        : engine.decodeString(source.subarray(index, end + 1));
                    if (decodeStringToken(token, 0, token.length) === BUNDLE_SPECIFIER) return true;
                }
                break;
            }
            if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) break;
            if (code === 92) {
                hasEscape = true;
                const next = codeAt(source, end + 1);
                if (next === 10 || next === 13 || next === 0x2028 || next === 0x2029 ||
                    (next === 0xe2 && codeAt(source, end + 2) === 0x80 &&
                        (codeAt(source, end + 3) === 0xa8 || codeAt(source, end + 3) === 0xa9))) return true;
                end++;
            }
            end++;
        }
        if (end - index > 128) return true;
    }
    return false;
}

function codeAt(source: string | Uint8Array, index: number): number {
    return typeof source === 'string' ? source.charCodeAt(index) : source[index]!;
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
 * Throw a located TransformError when `bytes` is not valid UTF-8; only the
 * oxc-declined path calls this, so well-formed sources are unaffected.
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
 * Byte offset of the first invalid UTF-8 sequence, or -1. Must fail loudly:
 * oxc returns null on non-UTF-8 (looks like "declined") and the Sucrase
 * fallback would erase namespaces/decorators silently. A false positive here
 * is untestable end to end, hence exported for unit tests. */
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
