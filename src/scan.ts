import { parse } from '../deps/sucrase/src/parser';
import {
    IdentifierRole,
    isBlockScopedDeclaration,
    isFunctionScopedDeclaration,
    isTopLevelDeclaration,
} from '../deps/sucrase/src/parser/tokenizer';
import { TokenType as tt } from '../deps/sucrase/src/parser/tokenizer/types';
import { ContextualKeyword } from '../deps/sucrase/src/parser/tokenizer/keywords';

export function extractImports(source: string, isTs = true, strict = false): string[] {
    let file: ReturnType<typeof parse>;
    try {
        file = parse(source, true, isTs, false);
    } catch (e) {
        if (strict) throw e;
        return [];
    }

    const tokens = file.tokens;
    const requireShadowScopes = findRequireShadowScopes(source, tokens, file.scopes);
    let specs: Set<string> | null = null;

    const tokenCount = tokens.length;
    for (let i = 0; i < tokenCount; i++) {
        const tok = tokens[i];
        if (!tok) continue;
        if (tok.type === tt._import) {
            const next = tokens[i + 1];
            if (!next) continue;
            if (next.type === tt.parenL) {
                const specToken = tokens[i + 2];
                const afterSpec = tokens[i + 3];
                if (specToken && specToken.type === tt.string &&
                    afterSpec && (afterSpec.type === tt.parenR || afterSpec.type === tt.comma)) {
                    specs ??= new Set<string>();
                    specs.add(decodeStringToken(source, specToken.start, specToken.end));
                }
                continue;
            }
            if (next.type === tt.string) {
                specs ??= new Set<string>();
                specs.add(decodeStringToken(source, next.start, next.end));
                continue;
            }
            // type-only import; `import type from '…'` is a value binding named type.
            if (next.type === tt.name && next.contextualKeyword === ContextualKeyword._type) {
                const afterType = tokens[i + 2];
                if (!afterType || afterType.contextualKeyword !== ContextualKeyword._from) continue;
            }
            const si = findFromString(tokens, i + 1);
            if (si !== -1 && hasRuntimeImportSpecifier(tokens, i + 1, si)) {
                const specToken = tokens[si];
                if (specToken) {
                    specs ??= new Set<string>();
                    specs.add(decodeStringToken(source, specToken.start, specToken.end));
                }
            }
            continue;
        }
        if (tok.type === tt._export) {
            // `export type { X } from '...'` / `export type * from '...'` — type-only, skip.
            const next = tokens[i + 1];
            if (next && next.type === tt.name && next.contextualKeyword === ContextualKeyword._type) continue;
            const si = findFromString(tokens, i + 1);
            if (si !== -1 && hasRuntimeExportSpecifier(tokens, i + 1, si)) {
                const specToken = tokens[si];
                if (specToken) {
                    specs ??= new Set<string>();
                    specs.add(decodeStringToken(source, specToken.start, specToken.end));
                }
            }
            continue;
        }
        const parenToken = tokens[i + 1];
        const specToken = tokens[i + 2];
        if (tok.type === tt.name &&
            tok.identifierRole === IdentifierRole.Access &&
            isRequireToken(source, tok.start, tok.end) &&
            !isShadowedRequire(i, requireShadowScopes) &&
            parenToken && parenToken.type === tt.parenL &&
            specToken && specToken.type === tt.string &&
            tokens[i + 3]?.type === tt.parenR)
        {
            specs ??= new Set<string>();
            specs.add(decodeStringToken(source, specToken.start, specToken.end));
        }
    }
    return specs ? [...specs] : [];
}

/** Import attrs present? Linear scan only (no full TS parse). Prefer false+ for pack. */
export function hasImportAttributes(source: string, _isTs = true): boolean {
    const n = source.length;
    let i = 0;
    while (i < n) {
        const c = source.charCodeAt(i);
        // Skip // and /* */ comments so "with" inside them is ignored.
        if (c === 47 && i + 1 < n) {
            const n1 = source.charCodeAt(i + 1);
            if (n1 === 47) {
                i += 2;
                while (i < n && source.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (n1 === 42) {
                i += 2;
                while (i + 1 < n && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
        }
        // Skip string / template literals.
        if (c === 34 || c === 39 || c === 96) {
            const q = c;
            i++;
            while (i < n) {
                const ch = source.charCodeAt(i);
                if (ch === 92) { i += 2; continue; }
                if (ch === q) { i++; break; }
                i++;
            }
            continue;
        }
        // import / export … with {  |  assert {
        if ((c === 105 || c === 101) && isWordAt(source, i, c === 105 ? 'import' : 'export')) {
            const kwLen = c === 105 ? 6 : 6;
            if (!isIdentBoundary(source, i + kwLen)) { i++; continue; }
            const end = Math.min(n, i + 4000);
            let j = i + kwLen;
            let depth = 0;
            while (j < end) {
                const cj = source.charCodeAt(j);
                if (cj === 34 || cj === 39 || cj === 96) {
                    const q = cj;
                    j++;
                    while (j < end) {
                        const ch = source.charCodeAt(j);
                        if (ch === 92) { j += 2; continue; }
                        if (ch === q) { j++; break; }
                        j++;
                    }
                    // After a string in an import/export, accept with/assert {
                    while (j < end && isWs(source.charCodeAt(j))) j++;
                    if (isWordAt(source, j, 'with') || isWordAt(source, j, 'assert')) {
                        let k = j + (source.charCodeAt(j) === 119 ? 4 : 6);
                        while (k < end && isWs(source.charCodeAt(k))) k++;
                        if (k < end && source.charCodeAt(k) === 123) return true;
                    }
                    continue;
                }
                if (cj === 123) depth++;
                else if (cj === 125) depth = Math.max(0, depth - 1);
                else if (cj === 59 && depth === 0) break;
                j++;
            }
            i = j;
            continue;
        }
        i++;
    }
    return false;
}

function isWs(c: number): boolean {
    return c === 32 || c === 9 || c === 10 || c === 13;
}

function isIdentBoundary(source: string, idx: number): boolean {
    if (idx >= source.length) return true;
    const c = source.charCodeAt(idx);
    return !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 36 || c === 95);
}

function isWordAt(source: string, idx: number, word: string): boolean {
    if (idx + word.length > source.length) return false;
    if (idx > 0 && !isIdentBoundary(source, idx - 1) && !isWs(source.charCodeAt(idx - 1))) {
        // previous char must not be identifier-continue (start of keyword)
        const p = source.charCodeAt(idx - 1);
        if ((p >= 65 && p <= 90) || (p >= 97 && p <= 122) || (p >= 48 && p <= 57) || p === 36 || p === 95) {
            return false;
        }
    }
    for (let k = 0; k < word.length; k++) {
        if (source.charCodeAt(idx + k) !== word.charCodeAt(k)) return false;
    }
    return isIdentBoundary(source, idx + word.length);
}

type Tokens = ReturnType<typeof parse>['tokens'];
type Scopes = ReturnType<typeof parse>['scopes'];

interface TokenRange {
    startTokenIndex: number;
    endTokenIndex: number;
}

function findRequireShadowScopes(source: string, tokens: Tokens, scopes: Scopes): TokenRange[] {
    const ranges: TokenRange[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token || token.type !== tt.name || token.isType ||
            !isRequireToken(source, token.start, token.end)) {
            continue;
        }
        if (isTopLevelDeclaration(token)) {
            return [{ startTokenIndex: 0, endTokenIndex: tokens.length }];
        }
        const functionScoped = isFunctionScopedDeclaration(token);
        if (!functionScoped && !isBlockScopedDeclaration(token)) continue;

        let best: TokenRange | null = null;
        for (const scope of scopes) {
            if (scope.startTokenIndex > i || i >= scope.endTokenIndex ||
                (functionScoped && !scope.isFunctionScope)) {
                continue;
            }
            if (!best ||
                scope.endTokenIndex - scope.startTokenIndex <
                    best.endTokenIndex - best.startTokenIndex) {
                best = scope;
            }
        }
        if (best && !ranges.some(range =>
            range.startTokenIndex === best.startTokenIndex &&
            range.endTokenIndex === best.endTokenIndex)) {
            ranges.push(best);
        }
    }
    return ranges;
}

function isShadowedRequire(tokenIndex: number, ranges: TokenRange[]): boolean {
    return ranges.some(range =>
        range.startTokenIndex <= tokenIndex && tokenIndex < range.endTokenIndex);
}

function decodeStringToken(source: string, start: number, end: number): string {
    const contentStart = start + 1;
    const contentEnd = end - 1;
    const firstSlash = source.indexOf('\\', contentStart);
    if (firstSlash === -1 || firstSlash >= contentEnd) {
        return source.slice(contentStart, contentEnd);
    }

    let value = source.slice(contentStart, firstSlash);
    let i = firstSlash;
    while (i < contentEnd) {
        const code = source.charCodeAt(i++);
        if (code !== 92) {
            value += String.fromCharCode(code);
            continue;
        }
        if (i >= contentEnd) {
            value += '\\';
            break;
        }

        const escaped = source.charCodeAt(i++);
        if (escaped === 10 || escaped === 0x2028 || escaped === 0x2029) continue;
        if (escaped === 13) {
            if (source.charCodeAt(i) === 10) i++;
            continue;
        }
        if (escaped >= 48 && escaped <= 55) {
            let charCode = escaped - 48;
            const limit = escaped <= 51 ? 3 : 2;
            let digits = 1;
            while (digits < limit && i < contentEnd) {
                const next = source.charCodeAt(i);
                if (next < 48 || next > 55) break;
                charCode = charCode * 8 + next - 48;
                digits++;
                i++;
            }
            value += String.fromCharCode(charCode);
            continue;
        }

        switch (escaped) {
            case 98: value += '\b'; break;
            case 102: value += '\f'; break;
            case 110: value += '\n'; break;
            case 114: value += '\r'; break;
            case 116: value += '\t'; break;
            case 118: value += '\v'; break;
            case 120: {
                const decoded = decodeFixedHex(source, i, 2, contentEnd);
                if (decoded === null) value += '\\x';
                else {
                    value += String.fromCharCode(decoded);
                    i += 2;
                }
                break;
            }
            case 117: {
                if (source.charCodeAt(i) === 123) {
                    const close = source.indexOf('}', i + 1);
                    const raw = close === -1 || close >= contentEnd ? '' : source.slice(i + 1, close);
                    const decoded = raw.length > 0 ? decodeHex(raw) : null;
                    if (decoded === null || decoded > 0x10ffff) value += '\\u';
                    else {
                        value += String.fromCodePoint(decoded);
                        i = close + 1;
                    }
                } else {
                    const decoded = decodeFixedHex(source, i, 4, contentEnd);
                    if (decoded === null) value += '\\u';
                    else {
                        value += String.fromCharCode(decoded);
                        i += 4;
                    }
                }
                break;
            }
            default: value += String.fromCharCode(escaped);
        }
    }
    return value;
}

function decodeFixedHex(source: string, start: number, length: number, end: number): number | null {
    if (start + length > end) return null;
    let value = 0;
    for (let i = start; i < start + length; i++) {
        const digit = hexDigit(source.charCodeAt(i));
        if (digit === -1) return null;
        value = value * 16 + digit;
    }
    return value;
}

function decodeHex(raw: string): number | null {
    let value = 0;
    for (let i = 0; i < raw.length; i++) {
        const digit = hexDigit(raw.charCodeAt(i));
        if (digit === -1) return null;
        value = value * 16 + digit;
    }
    return value;
}

function hexDigit(code: number): number {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    if (code >= 97 && code <= 102) return code - 87;
    return -1;
}

export function isTsLikePath(filename: string): boolean {
    const length = filename.length;
    if (length < 3) return false;
    const last = filename.charCodeAt(length - 1);
    if (last === 115) {
        if (filename.charCodeAt(length - 2) !== 116) return false;
        const third = filename.charCodeAt(length - 3);
        if (third === 46) return true;
        if (length >= 4 &&
            (third === 109 || third === 99) &&
            filename.charCodeAt(length - 4) === 46) {
            return true;
        }
        return false;
    }
    if (last !== 120 || length < 4) return false;
    if (filename.charCodeAt(length - 2) !== 115 ||
        filename.charCodeAt(length - 3) !== 116) {
        return false;
    }
    const fourth = filename.charCodeAt(length - 4);
    return fourth === 46 ||
        (length >= 5 &&
            (fourth === 109 || fourth === 99) &&
            filename.charCodeAt(length - 5) === 46);
}

export function isScannablePath(filename: string): boolean {
    const length = filename.length;
    if (length < 3) return false;
    const last = filename.charCodeAt(length - 1);
    if (last === 115) {
        const prev = filename.charCodeAt(length - 2);
        // .ts / .mts / .cts (same family as isTsLikePath, plus JS below)
        if (prev === 116) {
            const third = filename.charCodeAt(length - 3);
            if (third === 46) return true;
            return length >= 4 &&
                (third === 109 || third === 99) &&
                filename.charCodeAt(length - 4) === 46;
        }
        // .js / .mjs / .cjs
        if (prev !== 106) return false;
        const third = filename.charCodeAt(length - 3);
        return third === 46 ||
            (length >= 4 &&
                (third === 109 || third === 99) &&
                filename.charCodeAt(length - 4) === 46);
    }
    if (last !== 120 || length < 4) return false;
    const prev = filename.charCodeAt(length - 2);
    if (prev !== 115) return false;
    const third = filename.charCodeAt(length - 3);
    return (third === 116 || third === 106) &&
        filename.charCodeAt(length - 4) === 46;
}

export function isWasmPath(filename: string): boolean {
    const length = filename.length;
    return length >= 5 &&
        filename.charCodeAt(length - 1) === 109 &&
        filename.charCodeAt(length - 2) === 115 &&
        filename.charCodeAt(length - 3) === 97 &&
        filename.charCodeAt(length - 4) === 119 &&
        filename.charCodeAt(length - 5) === 46;
}

function isRequireToken(source: string, start: number, end: number): boolean {
    return end - start === 7 &&
        source.charCodeAt(start) === 114 &&
        source.charCodeAt(start + 1) === 101 &&
        source.charCodeAt(start + 2) === 113 &&
        source.charCodeAt(start + 3) === 117 &&
        source.charCodeAt(start + 4) === 105 &&
        source.charCodeAt(start + 5) === 114 &&
        source.charCodeAt(start + 6) === 101;
}

function hasRuntimeImportSpecifier(tokens: Tokens, start: number, fromStringIndex: number): boolean {
    let sawImportDeclaration = false;
    for (let i = start; i < fromStringIndex; i++) {
        const t = tokens[i];
        if (!t) continue;
        if (t.identifierRole !== IdentifierRole.ImportDeclaration) continue;
        sawImportDeclaration = true;
        if (!t.isType) return true;
    }
    return !sawImportDeclaration;
}

function hasRuntimeExportSpecifier(tokens: Tokens, start: number, fromStringIndex: number): boolean {
    let sawExportAccess = false;
    for (let i = start; i < fromStringIndex; i++) {
        const t = tokens[i];
        if (!t) continue;
        if (t.identifierRole !== IdentifierRole.ExportAccess) continue;
        sawExportAccess = true;
        if (!t.isType) return true;
    }
    return !sawExportAccess;
}

function findFromString(
    tokens: Tokens,
    start: number,
): number {
    // No token cap on named imports — short windows drop edges (pack fails later).
    let braceDepth = 0;
    for (let i = start; i < tokens.length; i++) {
        const t = tokens[i];
        if (!t) continue;
        if (t.type === tt.braceL) {
            braceDepth++;
            continue;
        }
        if (t.type === tt.braceR) {
            braceDepth--;
            continue;
        }
        if (braceDepth > 0) continue;
        if (t.type === tt.semi) break;
        if (t.type === tt.name &&
            t.contextualKeyword === ContextualKeyword._from) {
            const next = tokens[i + 1];
            if (next && next.type === tt.string) return i + 1;
        }
    }
    return -1;
}
