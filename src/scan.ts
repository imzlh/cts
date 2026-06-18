// scan.ts — import specifier extraction (sucrase token-based)
// Lives here so precompile workers can import it without pulling in the full
// BFS scanner (resolver, progress, asyncfs, wasm, etc.).

import { parse } from '../deps/sucrase/src/parser';
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
            const si = findFromString(tokens, i + 1);
            if (si !== -1) specs.add(sv(si));
            continue;
        }
        if (tok.type === tt._export) {
            const si = findFromString(tokens, i + 1);
            if (si !== -1) specs.add(sv(si));
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

function findFromString(
    tokens: ReturnType<typeof parse>['tokens'],
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
