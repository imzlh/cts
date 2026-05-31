// protocol/http.ts — http/https handler

import type { RuntimeConfig, ModuleInfo } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { joinPaths, dirname } from '../utils/path';
import { ensureDir } from '../utils/io';
import { cacheFilename } from '../utils/misc';
import { fetchAsync, type ProgressCallback } from '@cnojs/http/fetch';
// URL polyfill — CNO runtime provides global URL
declare const URL: any;
import { fs, engine } from '../utils/index';
import { log } from '../utils/log';
import { isatty } from '../utils/progress';

export class HttpHandler implements ProtocolHandler {
    readonly protocols = ['http', 'https'];

    // Maps canonical specPath (URL) → local cache path
    private readonly resolved = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {}

    private fetchOptions() {
        return { timeout: this.cfg.requestTimeout };
    }

    private fetchBytesSync(url: string): Uint8Array {
        const result = engine.waitPromise(
            fetchAsync(url, undefined, this.fetchOptions())
                .then(({ body }) => body)
                .catch((error) => ({ __fetchError: error }))
        ) as Uint8Array | { __fetchError: unknown };
        if (result && typeof result === 'object' && '__fetchError' in result) {
            throw result.__fetchError;
        }
        return result as Uint8Array;
    }

    resolve(spec: string, parent: string, _attr?: Record<string, any>): ModuleInfo {
        const url = this.normalizeUrl(spec, parent);
        if (!this.resolved.has(url)) {
            const cachePath = this.cachePath(url);
            if (!fs.exists(cachePath)) {
                if (!this.cfg.silent && !isatty) log.info(`📦 ${url}`);
                const body = this.fetchBytesSync(url);
                ensureDir(dirname(cachePath));
                fs.writeFile(cachePath, body);
            }
            this.resolved.set(url, cachePath);
        }
        const localPath = this.resolved.get(url)!;
        return { specPath: url, localPath, format: 'esm', fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string {
        return this.resolved.get(specPath) ?? this.cachePath(specPath);
    }

    async resolveAsync(spec: string, parent: string, _attr?: Record<string, any>, onProgress?: ProgressCallback): Promise<ModuleInfo> {
        const url = this.normalizeUrl(spec, parent);
        if (!this.resolved.has(url)) {
            const cachePath = this.cachePath(url);
            if (!fs.exists(cachePath)) {
                if (!this.cfg.silent && !isatty) log.info(`📦 ${url}`);
                const { body } = await fetchAsync(url, onProgress, this.fetchOptions());
                ensureDir(dirname(cachePath));
                fs.writeFile(cachePath, body);
            }
            this.resolved.set(url, cachePath);
        }
        const localPath = this.resolved.get(url)!;
        return { specPath: url, localPath, format: 'esm', fileKind: guessFileKind(localPath) };
    }

    private normalizeUrl(spec: string, parent: string): string {
        if (spec.startsWith('http://') || spec.startsWith('https://')) return spec;
        // relative or absolute-path import within an HTTP module
        return new URL(spec, parent).toString();
    }

    private cachePath(url: string): string {
        const { hostname } = new URL(url);
        const name = cacheFilename(url);
        return joinPaths(this.cfg.cacheDir, 'http', hostname, name.slice(0, 2), name);
    }
}
