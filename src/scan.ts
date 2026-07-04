// scan.ts — import specifier extraction (sucrase token-based)
// Lives here so parse workers can import it without pulling in the full
// BFS scanner (resolver, progress, asyncfs, wasm, etc.).

import { parse } from '../deps/sucrase/src/parser';
import { IdentifierRole } from '../deps/sucrase/src/parser/tokenizer';
import { TokenType as tt } from '../deps/sucrase/src/parser/tokenizer/types';
import { ContextualKeyword } from '../deps/sucrase/src/parser/tokenizer/keywords';

export const SCANNABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
export const WASM_EXT = '.wasm';

export function extractImports(source: string, isTs = true): string[] {
    if (!source.includes('import') && !source.includes('export') && !source.includes('require')) return [];
    let tokens;
    try {
        const file = parse(source, true, isTs, false);
        tokens = file.tokens;
    } catch { return []; }

    const sv = (i: number) => source.slice(tokens[i]!.start + 1, tokens[i]!.end - 1);
    const specs = new Set<string>();

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok.type === tt._import) {
            const next = tokens[i + 1];
            if (!next) continue;
            if (next.type === tt.parenL) {
                if (tokens[i + 2]?.type === tt.string) specs.add(sv(i + 2));
                continue;
            }
            if (next.type === tt.string) { specs.add(sv(i + 1)); continue; }
            // `import type { X }` / `import type * as X` / `import type X` — type-only, skip.
            // Exception: `import type from '...'` where "from" follows directly — that's a
            // value default import with the binding named "type".
            if (next.type === tt.name && next.contextualKeyword === ContextualKeyword._type) {
                const afterType = tokens[i + 2];
                if (!afterType || afterType.contextualKeyword !== ContextualKeyword._from) continue;
            }
            const si = findFromString(tokens, i + 1);
            if (si !== -1 && hasRuntimeImportSpecifier(tokens, i + 1, si)) specs.add(sv(si));
            continue;
        }
        if (tok.type === tt._export) {
            // `export type { X } from '...'` / `export type * from '...'` — type-only, skip.
            const next = tokens[i + 1];
            if (next && next.type === tt.name && next.contextualKeyword === ContextualKeyword._type) continue;
            const si = findFromString(tokens, i + 1);
            if (si !== -1 && hasRuntimeExportSpecifier(tokens, i + 1, si)) specs.add(sv(si));
            continue;
        }
        if (tok.type === tt.name &&
            source.slice(tok.start, tok.end) === 'require' &&
            tokens[i + 1]?.type === tt.parenL &&
            tokens[i + 2]?.type === tt.string)
            specs.add(sv(i + 2));
    }
    return [...specs];
}

type Tokens = ReturnType<typeof parse>['tokens'];

function hasRuntimeImportSpecifier(tokens: Tokens, start: number, fromStringIndex: number): boolean {
    let sawImportDeclaration = false;
    for (let i = start; i < fromStringIndex; i++) {
        const t = tokens[i]!;
        if (t.identifierRole !== IdentifierRole.ImportDeclaration) continue;
        sawImportDeclaration = true;
        if (!t.isType) return true;
    }
    return !sawImportDeclaration;
}

function hasRuntimeExportSpecifier(tokens: Tokens, start: number, fromStringIndex: number): boolean {
    let sawExportAccess = false;
    for (let i = start; i < fromStringIndex; i++) {
        const t = tokens[i]!;
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
        const t = tokens[i]!;
        if (t.type === tt.braceL) { braceDepth++; continue; }
        if (t.type === tt.braceR) { braceDepth--; continue; }
        if (braceDepth > 0) continue;
        if (t.type === tt.semi) break;
        if (t.type === tt.name &&
            t.contextualKeyword === ContextualKeyword._from &&
            tokens[i + 1]?.type === tt.string) return i + 1;
    }
    return -1;
}
