// deps.ts — parallel async BFS dependency scanner
//
// Algorithm: level-by-level BFS.
//   1. Parse a batch of already-local files simultaneously (asyncfs)
//      → collect all import specifiers
//   2. Resolve specifiers → split: already-cached vs needs-download
//   3. Fire ALL downloads for this level in parallel (Promise.allSettled + curl)
//   4. Newly downloaded files form the next batch → repeat from 1
//
// Net effect: every file at the same BFS depth is downloaded concurrently.
// Only the unavoidable inter-level dependency remains serialised.

import { parse } from '../deps/sucrase/src/parser';
import { TokenType as tt } from '../deps/sucrase/src/parser/tokenizer/types';
import { ContextualKeyword } from '../deps/sucrase/src/parser/tokenizer/keywords';

import type { RuntimeConfig, ModuleInfo } from './types';
import { ModuleResolver } from './resolver';
import { ensureDir } from './utils/io';
import { dirname, extname } from './utils/path';
import { errMsg } from './utils/misc';
import { log } from './utils/log';
import { fetchAsync } from './utils/curl';
import { MultiProgress } from './utils/progress';
import { fs, engine, asyncfs } from './utils/index';

// ---------------------------------------------------------------------------
// Import specifier extraction — sucrase token-based, no regex
// ---------------------------------------------------------------------------

const SCANNABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export function extractImports(source: string, isTs = true): string[] {
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
    const limit = Math.min(start + 64, tokens.length);
    for (let i = start; i < limit; i++) {
        const t = tokens[i]!;
        if (t.type === tt.semi) break;
        if (t.type === tt.name &&
            t.contextualKeyword === ContextualKeyword._from &&
            tokens[i + 1]?.type === tt.string) return i + 1;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Parallel BFS
// ---------------------------------------------------------------------------

interface DownloadTask {
    url:       string;
    cachePath: string;
    info:      ModuleInfo;
}

export interface ScanResult {
    visited:    number;
    downloaded: number;
    errors: Array<{ spec: string; parent: string; error: string }>;
}

export class DepScanner {
    private readonly seen  = new Set<string>();
    private readonly errs: ScanResult['errors'] = [];
    private downloaded = 0;

    constructor(
        private readonly resolver: ModuleResolver,
        private readonly cfg:      RuntimeConfig,
    ) {}

    async scan(entrySpecPath: string, entryLocalPath: string): Promise<ScanResult> {
        this.seen.clear();
        this.errs.length = 0;
        this.downloaded  = 0;

        const prog = this.cfg.silent ? null : new MultiProgress(6);
        let batch: Array<{ specPath: string; localPath: string }> =
            [{ specPath: entrySpecPath, localPath: entryLocalPath }];

        try {
            while (batch.length > 0) {
                // Phase 1 — parse this level's files concurrently (asyncfs)
                const specifiers = await this.parseLevel(batch);

                // Phase 2 — resolve; classify cached vs needs-download
                const tasks: DownloadTask[] = [];
                const next:  typeof batch   = [];

                for (const { spec, parent } of specifiers) {
                    let info: ModuleInfo;
                    try   { info = this.resolver.resolve(spec, parent); }
                    catch (e) { this.errs.push({ spec, parent, error: errMsg(e) }); continue; }

                    if (this.seen.has(info.specPath)) continue;
                    this.seen.add(info.specPath);

                    if (fs.exists(info.localPath)) {
                        if (SCANNABLE.has(extname(info.localPath)))
                            next.push({ specPath: info.specPath, localPath: info.localPath });
                    } else {
                        const url = this.urlFor(info);
                        if (url) {
                            tasks.push({ url, cachePath: info.localPath, info });
                            prog?.add(info.specPath, short(info.specPath));
                        }
                        // No URL (npm tarball etc.) — resolver already handled it
                    }
                }

                // Phase 3 — download this level in parallel
                if (tasks.length > 0) {
                    const fresh = await this.downloadLevel(tasks, prog);
                    for (const info of fresh)
                        if (SCANNABLE.has(extname(info.localPath)))
                            next.push({ specPath: info.specPath, localPath: info.localPath });
                }

                batch = next;
            }
        } finally {
            // Always stop progress display; curl pool is released by resources.ts
            prog?.stop();
        }

        if (!this.cfg.silent) {
            const e = this.errs.length ? `, ${this.errs.length} error(s)` : '';
            log.info(`✅ ${this.seen.size} modules (${this.downloaded} downloaded)${e}`);
        }
        return { visited: this.seen.size, downloaded: this.downloaded, errors: [...this.errs] };
    }

    // -------------------------------------------------------------------------
    // Read + parse a batch of files with asyncfs concurrently
    // -------------------------------------------------------------------------

    private async parseLevel(
        batch: Array<{ specPath: string; localPath: string }>,
    ): Promise<Array<{ spec: string; parent: string }>> {
        const results = await Promise.all(batch.map(async ({ specPath, localPath }) => {
            if (!SCANNABLE.has(extname(localPath))) return [];
            try {
                const bytes = await asyncfs.readFile(localPath);
                const src   = engine.decodeString(bytes);
                const isTs  = /\.[mc]?tsx?$/.test(localPath);
                return extractImports(src, isTs).map(spec => ({ spec, parent: specPath }));
            } catch { return []; }
        }));
        return results.flat();
    }

    // -------------------------------------------------------------------------
    // Download a batch of files with libcurl — all concurrent
    // -------------------------------------------------------------------------

    private async downloadLevel(
        tasks: DownloadTask[],
        prog:  MultiProgress | null,
    ): Promise<ModuleInfo[]> {
        const done: ModuleInfo[] = [];

        await Promise.allSettled(tasks.map(async (t) => {
            try {
                const { body } = await fetchAsync(
                    t.url,
                    (now, total) => prog?.update(t.info.specPath, now, total),
                );
                ensureDir(dirname(t.cachePath));
                fs.writeFile(t.cachePath, body);
                prog?.finish(t.info.specPath);
                this.downloaded++;
                done.push(t.info);
            } catch (e) {
                prog?.finish(t.info.specPath, errMsg(e));
                this.errs.push({ spec: t.info.specPath, parent: '<download>', error: errMsg(e) });
            }
        }));

        return done;
    }

    // -------------------------------------------------------------------------
    // Determine the direct download URL for a ModuleInfo, or null
    // -------------------------------------------------------------------------

    private urlFor(info: ModuleInfo): string | null {
        const sp = info.specPath;
        // HTTP/HTTPS — specPath is the URL
        if (sp.startsWith('http://') || sp.startsWith('https://')) return sp;
        // JSR — reconstruct from canonical specPath: jsr:@scope/name@ver/file
        const m = sp.match(/^jsr:@([^/]+)\/([^@]+)@([^/]+)\/(.+)$/);
        if (m) return `https://jsr.io/@${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
        // npm tarballs are handled by the npm resolver (tarball fetch + extract);
        // we can't trivially replicate that here, so fall through to resolver.
        return null;
    }
}

function short(sp: string): string {
    return sp.length <= 55 ? sp : '…' + sp.slice(-54);
}
