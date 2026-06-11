// protocol/http.ts - http/https handler

import type { RuntimeConfig, ModuleInfo } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { StepType, type Flow } from '../flow';
import { joinPaths, dirname } from '../utils/path';
import { cacheFilename } from '../utils/misc';
declare const URL: any;
import { log } from '../utils/log';
import { isatty } from '../utils/progress';

export class HttpHandler implements ProtocolHandler {
    readonly protocols = ['http', 'https'];
    private readonly resolved = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {}

    *resolve(spec: string, parent: string): Flow<ModuleInfo> {
        const url = this.normalizeUrl(spec, parent);
        const cachePath = this.cachePath(url);
        if (!this.resolved.has(url)) {
            const cached = yield { type: StepType.FS_EXISTS, path: cachePath };
            if (!cached) {
                if (!this.cfg.silent && !isatty) log.download(url);
                const { body } = yield {
                    type: StepType.NET_FETCH,
                    url,
                    timeout: this.cfg.requestTimeout,
                };
                yield { type: StepType.FS_ENSURE_DIR, path: dirname(cachePath) };
                yield { type: StepType.FS_WRITE_BYTES, path: cachePath, data: body };
            }
            this.resolved.set(url, cachePath);
        }
        const localPath = this.resolved.get(url)!;
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
