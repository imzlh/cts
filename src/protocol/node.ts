// protocol/node.ts — node: builtin module handler

import type { RuntimeConfig, ModuleInfo, NodeBuiltinResolver } from '../types';
import type { ProtocolHandler } from './base';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { detectFormat } from '../pkg';

import { log } from '../utils/log';
import { fs } from '../utils/index';

export class NodeHandler implements ProtocolHandler {
    readonly protocols = ['node'];
    private externalResolver: NodeBuiltinResolver | null = null;

    constructor(private readonly cfg: RuntimeConfig) {}

    registerResolver(r: NodeBuiltinResolver): void {
        this.externalResolver = r;
    }

    resolve(spec: string, parent: string): ModuleInfo {
        const bare = spec.startsWith('node:') ? spec.slice(5) : spec;

        // Relative import from inside a node: polyfill
        // Polyfill files are flat under node/<module>/, so relative paths like ./utils
        // from node:fs/sync should resolve to node:fs/utils (not node:fs/sync/utils)
        if ((bare.startsWith('./') || bare.startsWith('../')) && parent.startsWith('node:')) {
            const parentBare = parent.slice(5); // e.g., "fs" or "fs/sync" from "node:fs" or "node:fs/sync"
            const topModule = parentBare.split('/')[0]!; // e.g., "fs" from "fs/sync"
            // Resolve relative path against the parent's directory within the top module
            const parentDir = parentBare.includes('/') ? dirname(parentBare) : parentBare;
            const resolved = normalizePath(joinPaths(parentDir, bare));
            // Security: ensure the resolved path doesn't escape the top module's namespace
            // e.g., fs/../path is OK (resolves to path), but fs/../../other is not
            if (!resolved.startsWith(topModule) && !resolved.startsWith(topModule + '/')) {
                throw new Error(`Relative import "${bare}" from "${parent}" escapes module boundary "${topModule}"`);
            }
            const localPath = this.findPolyfill(resolved);
            const specPath  = `node:${resolved}`;
            return { specPath, localPath, format: detectFormat(localPath), fileKind: 'source' };
        }

        const specPath  = `node:${bare}`;
        const localPath = this.findPolyfill(bare);
        return { specPath, localPath, format: detectFormat(localPath), fileKind: 'source' };
    }

    localPath(specPath: string): string {
        const bare = specPath.startsWith('node:') ? specPath.slice(5) : specPath;
        // Handle nested paths like fs/sync/utils -> fs/utils (flat structure)
        if (bare.includes('/')) {
            const parts = bare.split('/');
            const topModule = parts[0]!;
            // Take last part for flat structure: fs/sync/utils -> utils -> fs/utils
            const lastPart = parts[parts.length - 1]!;
            return this.findPolyfill(joinPaths(topModule, lastPart));
        }
        return this.findPolyfill(bare);
    }

    private findPolyfill(bare: string): string {
        if (this.externalResolver) {
            const p = this.externalResolver(bare);
            if (p) { log.debug('node', () => `external → ${p}`); return p; }
        }
        const nodeDir = joinPaths(this.cfg.cacheDir, 'node');
        // e.g. fs/promises → node/fs/promises.ts; fs → node/fs/index.ts
        const localPath = bare.includes('/')
            ? joinPaths(nodeDir, `${bare}.ts`)
            : joinPaths(nodeDir, bare, 'index.ts');
        if (!fs.exists(localPath)) throw new Error(`Node.js builtin "${bare}" has no polyfill at ${localPath}`);
        return localPath;
    }
}
