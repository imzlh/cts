import type { RuntimeConfig, ModuleInfo } from '../../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { expectFetch, StepType, type Flow, type ProgressCallback } from '../../flow';
import { joinPaths, dirname } from '../../utils/path';
import { cacheFilename } from '../../utils/misc';
import { log } from '../../utils/log';
import { isatty } from '../../utils/progress';
import { err, ErrorKind } from '../../errors';
import { URL } from '../../utils/url';

export class HttpHandler implements ProtocolHandler {
    readonly protocols = ['http', 'https'];
    private readonly resolved = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {}

    *resolve(spec: string, parent: string, attr?: Record<string, unknown>, onProgress?: ProgressCallback): Flow<ModuleInfo> {
        const url = this.normalizeUrl(spec, parent);
        const cachePath = this.cachePath(url);
        if (!this.resolved.has(url)) {
            const cached = yield { type: StepType.FS_EXISTS, path: cachePath };
            if (!cached) {
                if (!this.cfg.silent && !isatty) log.download(url);
                const result = expectFetch(yield {
                    type: StepType.NET_FETCH,
                    url,
                    timeout: this.cfg.requestTimeout,
                    onProgress,
                });
                if (result.status < 200 || result.status >= 300) {
                    throw err(ErrorKind.ModuleNotFound,
                        `HTTP ${result.status} fetching ${url}`);
                }
                yield { type: StepType.FS_ENSURE_DIR, path: dirname(cachePath) };
                yield { type: StepType.FS_WRITE_BYTES, path: cachePath, data: result.body };
            }
            this.resolved.set(url, cachePath);
        }
        const localPath = this.resolved.get(url) ?? cachePath;
        return { specPath: url, localPath, format: 'esm', fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string {
        return this.resolved.get(specPath) ?? this.cachePath(specPath);
    }

    /** Clear resolved cache */
    clearCache(): void {
        this.resolved.clear();
    }

    private normalizeUrl(spec: string, parent: string): string {
        if (spec.startsWith('http://') || spec.startsWith('https://')) return spec;
        return new URL(spec, parent).toString();
    }

    private cachePath(url: string): string {
        const { hostname } = new URL(url);
        const name = cacheFilename(url);
        return joinPaths(this.cfg.cacheDir, 'http', hostname, name.slice(0, 2), name);
    }
}
