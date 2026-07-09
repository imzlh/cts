// scan.ts — import specifier extraction (sucrase token-based)
// Lives here so parse workers can import it without pulling in the full
// BFS scanner (resolver, progress, asyncfs, wasm, etc.).

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
                if (specToken && specToken.type === tt.string) {
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
            // `import type { X }` / `import type * as X` / `import type X` — type-only, skip.
            // Exception: `import type from '...'` where "from" follows directly — that's a
            // value default import with the binding named "type".
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
            specToken && specToken.type === tt.string)
        {
            specs ??= new Set<string>();
            specs.add(source.slice(specToken.start + 1, specToken.end - 1));
        }
    }
    return specs ? [...specs] : [];
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
    const limit = Math.min(start + 80, tokens.length);
    let braceDepth = 0;
    for (let i = start; i < limit; i++) {
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
