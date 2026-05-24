import { parse } from '../deps/sucrase/src/parser';
import { TokenType as tt } from '../deps/sucrase/src/parser/tokenizer/types';
import { ContextualKeyword } from '../deps/sucrase/src/parser/tokenizer/keywords';

import type { RuntimeConfig } from './types';
import { ModuleResolver } from './resolver';
import { extname } from './utils/path';
import { errMsg } from './utils/misc';
import { log } from './utils/log';
import { PrecacheProgress } from './utils/progress';
import { fs, engine, asyncfs, wasm } from './utils/index';

// ---------------------------------------------------------------------------
// Import specifier extraction — sucrase token-based, no regex
// ---------------------------------------------------------------------------

const SCANNABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const WASM_EXT  = '.wasm';
// WASI module names — provided by the runtime, no JS resolution needed.
const WASI_MODS = new Set(['wasi_unstable', 'wasi_snapshot_preview1']);

export function extractImports(source: string, isTs = true): string[] {
    // Fast path: skip parse if source has no import/export/require keywords.
    // These substrings appear in every valid import/export/require statement.
    if (!source.includes('import') && !source.includes('export') && !source.includes('require')) return [];
    let tokens;
    try {
        const file = parse(source, true, isTs, false);
        tokens = file.tokens;
    } catch { return []; }

    // stringValue(i): equivalent to TokenProcessor.stringValueAtIndex —
    // strips the surrounding quote characters from a string token.
    const sv = (i: number) => source.slice(tokens[i]!.start + 1, tokens[i]!.end - 1);
    const specs = new Set<string>();

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok.type === tt._import) {
            const next = tokens[i + 1];
            if (!next) continue;
            if (next.type === tt.parenL) {                    // import('...')
                if (tokens[i + 2]?.type === tt.string) specs.add(sv(i + 2));
                continue;
            }
            if (next.type === tt.string) {                    // import '...'
                specs.add(sv(i + 1)); continue;
            }
            const si = findFromString(tokens, i + 1);         // import ... from '...'
            if (si !== -1) specs.add(sv(si));
            continue;
        }
        if (tok.type === tt._export) {                        // export ... from '...'
            const si = findFromString(tokens, i + 1);
            if (si !== -1) specs.add(sv(si));
            continue;
        }
        if (tok.type === tt.name &&                           // require('...')
            source.slice(tok.start, tok.end) === 'require' &&
            tokens[i + 1]?.type === tt.parenL &&
            tokens[i + 2]?.type === tt.string)
            specs.add(sv(i + 2));
    }
    return [...specs];
}

function findFromString(
    tokens: ReturnType<typeof parse>['tokens'],
    start:  number,
): number {
    const limit = Math.min(start + 80, tokens.length);
    let braceDepth = 0;
    for (let i = start; i < limit; i++) {
        const t = tokens[i]!;
        // Track brace depth to skip over { Foo, Bar } in export type { ... } from '...'
        if (t.type === tt.braceL) { braceDepth++; continue; }
        if (t.type === tt.braceR) { braceDepth--; continue; }
        // Only look for 'from' when not inside braces
        if (braceDepth > 0) continue;
        if (t.type === tt.semi) break;
        if (t.type === tt.name &&
            t.contextualKeyword === ContextualKeyword._from &&
            tokens[i + 1]?.type === tt.string) return i + 1;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Parallel BFS — full scan, no lock deps shortcut
// ---------------------------------------------------------------------------

export interface ScanResult {
    visited:    number;
    downloaded: number;
    errors: Array<{ spec: string; parent: string; error: string }>;
    modules:    Array<{ specPath: string; localPath: string }>;
}

export class DepScanner {
    private readonly seen  = new Set<string>();
    private readonly errs: ScanResult['errors'] = [];
    private readonly found: ScanResult['modules'] = [];
    private downloaded = 0;

    constructor(
        private readonly resolver: ModuleResolver,
        private readonly cfg:      RuntimeConfig,
        private readonly prog:     PrecacheProgress | null = null,
    ) {}

    async scan(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult> {
        this.seen.clear();
        this.errs.length = 0;
        this.found.length = 0;
        this.downloaded  = 0;

        let batch: Array<{ specPath: string; localPath: string }> =
            [{ specPath: entrySpecPath, localPath: entryLocalPath }];

        try {
            while (batch.length > 0) {
                const specifiers = await this.parseLevel(batch);
                const next: typeof batch = [];

                const promises = specifiers.map(({ spec, parent }) => {
                    let didDownload = false;
                    const baseProgress = this.prog?.onDownloadProgress(spec);
                    const onProgress = baseProgress
                        ? (now: number, total: number) => { didDownload = true; baseProgress(now, total); }
                        : undefined;

                    return this.resolver.resolveAsync(spec, parent, undefined, onProgress).then(
                        info => {
                            if (didDownload) this.downloaded++;
                            this.prog?.bumpResolved();
                            this.prog?.finishDownload(spec);
                            return { ok: true, info, spec, parent } as const;
                        },
                        e => {
                            this.prog?.bumpResolved();
                            this.prog?.finishDownload(spec, errMsg(e));
                            return { ok: false, error: e, spec, parent } as const;
                        },
                    );
                });

                const results = await Promise.all(promises);

                for (const r of results) {
                    if (!r.ok) {
                        this.errs.push({ spec: (r as any).spec, parent: (r as any).parent, error: errMsg((r as any).error) });
                        continue;
                    }
                    const info = r.info;
                    if (this.seen.has(info.specPath)) continue;
                    this.seen.add(info.specPath);
                    this.found.push({ specPath: info.specPath, localPath: info.localPath });

                    if (fs.exists(info.localPath) && (SCANNABLE.has(extname(info.localPath)) || extname(info.localPath) === WASM_EXT))
                        next.push({ specPath: info.specPath, localPath: info.localPath });
                }

                batch = next;
            }
        } finally {}

        if (!this.cfg.silent) {
            const e = this.errs.length ? `, ${this.errs.length} error(s)` : '';
            log.info(`✅ ${this.seen.size} modules${e}`);
        }
        return { visited: this.seen.size, downloaded: this.downloaded, errors: [...this.errs], modules: this.found };
    }

    // -------------------------------------------------------------------------
    // Read + parse a batch of files with asyncfs concurrently
    // -------------------------------------------------------------------------

    private async parseLevel(
        batch: Array<{ specPath: string; localPath: string }>,
    ): Promise<Array<{ spec: string; parent: string }>> {
        const results = await Promise.all(batch.map(async ({ specPath, localPath }) => {
            const ext = extname(localPath);
            if (ext === WASM_EXT) {
                // wasm imports are baked into the binary, not the surrounding
                // JS — extract them so JSR/HTTP-hosted glue modules (./wbg.js,
                // ./env.js …) get precached. Without this they're only
                // discovered at sync wasm-link time, which can't refresh.
                if (!wasm) return [];
                try {
                    const bytes = await asyncfs.readFile(localPath);
                    const wmod  = wasm.parseModule(new Uint8Array(bytes));
                    const seen  = new Set<string>();
                    for (const imp of wasm.moduleImports(wmod)) {
                        if (WASI_MODS.has(imp.module)) continue;
                        if (imp.module === 'env') continue;          // built-in fallback
                        if (seen.has(imp.module)) continue;
                        seen.add(imp.module);
                    }
                    return [...seen].map(spec => ({ spec, parent: specPath }));
                } catch (e) {
                    log.debug('deps', () => `wasm scan failed for ${localPath}: ${errMsg(e)}`);
                    return [];
                }
            }
            if (!SCANNABLE.has(ext)) return [];
            try {
                const bytes = await asyncfs.readFile(localPath);
                const src   = engine.decodeString(bytes);
                const isTs  = /\.[mc]?tsx?$/.test(localPath);
                return extractImports(src, isTs).map(spec => ({ spec, parent: specPath }));
            } catch { return []; }
        }));
        return results.flat();
    }
}