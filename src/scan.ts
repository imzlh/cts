import { parse } from '../deps/sucrase/src/parser';
import { IdentifierRole } from '../deps/sucrase/src/parser/tokenizer';
import { TokenType as tt } from '../deps/sucrase/src/parser/tokenizer/types';
import { ContextualKeyword } from '../deps/sucrase/src/parser/tokenizer/keywords';

export function extractImports(source: string, isTs = true): string[] {
    let tokens;
    try {
        const file = parse(source, true, isTs, false);
        tokens = file.tokens;
    } catch { return []; }

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
                    specs.add(source.slice(specToken.start + 1, specToken.end - 1));
                }
                continue;
            }
            if (next.type === tt.string) {
                specs ??= new Set<string>();
                specs.add(source.slice(next.start + 1, next.end - 1));
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
                    specs.add(source.slice(specToken.start + 1, specToken.end - 1));
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
                    specs.add(source.slice(specToken.start + 1, specToken.end - 1));
                }
            }
            continue;
        }
        const parenToken = tokens[i + 1];
        const specToken = tokens[i + 2];
        if (tok.type === tt.name &&
            isRequireToken(source, tok.start, tok.end) &&
            parenToken && parenToken.type === tt.parenL &&
            specToken && specToken.type === tt.string &&
            tokens[i + 3]?.type === tt.parenR)
        {
            specs ??= new Set<string>();
            specs.add(source.slice(specToken.start + 1, specToken.end - 1));
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

/** Top-level import/export (not import())? Linear scan; isTs unused. */
export function hasTopLevelEsmSyntax(source: string, _isTs = false): boolean {
    const n = source.length;
    let i = 0;
    let brace = 0;
    let paren = 0;
    let bracket = 0;
    while (i < n) {
        const c = source.charCodeAt(i);
        // // and /* */ comments
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
        // strings / templates (no full template nesting; good enough for dual detect)
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
        if (c === 123) { brace++; i++; continue; }
        if (c === 125) { brace = Math.max(0, brace - 1); i++; continue; }
        if (c === 40) { paren++; i++; continue; }
        if (c === 41) { paren = Math.max(0, paren - 1); i++; continue; }
        if (c === 91) { bracket++; i++; continue; }
        if (c === 93) { bracket = Math.max(0, bracket - 1); i++; continue; }
        // Only top-level statements count as ESM markers.
        if (brace === 0 && paren === 0 && bracket === 0) {
            if (c === 101 && isWordAt(source, i, 'export')) {
                return true;
            }
            if (c === 105 && isWordAt(source, i, 'import')) {
                let j = i + 6;
                while (j < n && isWs(source.charCodeAt(j))) j++;
                // dynamic import(...) is valid in CJS
                if (j < n && source.charCodeAt(j) === 40) {
                    i = j;
                    continue;
                }
                return true;
            }
        }
        i++;
    }
    return false;
}

type Tokens = ReturnType<typeof parse>['tokens'];

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
        if (prev === 116) {
            return filename.charCodeAt(length - 3) === 46;
        }
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
