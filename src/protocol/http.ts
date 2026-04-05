// protocol/http.ts — http/https handler

import type { RuntimeConfig, ModuleInfo } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { joinPaths, dirname } from '../utils/path';
import { ensureDir } from '../utils/io';
import { cacheFilename } from '../utils/misc';
import { fetchBytes } from '../utils/net';
import { URL } from '../http/url';
import { fs } from '../utils/index';
import { log } from '../utils/log';

export class HttpHandler implements ProtocolHandler {
    readonly protocols = ['http', 'https'];

    // Maps canonical specPath (URL) → local cache path
    private readonly resolved = new Map<string, string>();

    constructor(private readonly cfg: RuntimeConfig) {}

    resolve(spec: string, parent: string, _attr?: Record<string, any>): ModuleInfo {
        const url = this.normalizeUrl(spec, parent);
        if (!this.resolved.has(url)) {
            const cachePath = this.cachePath(url);
            if (!fs.exists(cachePath)) {
                if (!this.cfg.silent) log.info(`📦 ${url}`);
                const bytes = fetchBytes(url, !this.cfg.silent);
                ensureDir(dirname(cachePath));
                fs.writeFile(cachePath, bytes);
            }
            this.resolved.set(url, cachePath);
        }
        const localPath = this.resolved.get(url)!;
        return { specPath: url, localPath, format: 'esm', fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string {
        return this.resolved.get(specPath) ?? this.cachePath(specPath);
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
