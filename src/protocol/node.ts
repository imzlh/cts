// protocol/node.ts — node: builtin module handler

import type { RuntimeConfig, ModuleInfo, NodeBuiltinResolver } from '../types';
import type { ProtocolHandler } from './base';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { detectFormat } from '../pkg';

import { log } from '../utils/log';

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
            const normalizedBare = bare.startsWith('./') ? bare.slice(2) : bare;
            const topModule = parentBare.split('/')[0]!; // e.g., "fs" from "fs/sync"
            const joinedBare = normalizePath(joinPaths(topModule, normalizedBare)); // e.g., "path" from "fs/../path"
            const localPath = this.findPolyfill(joinedBare);
            const specPath  = `node:${joinedBare}`;
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
        return bare.includes('/')
            ? joinPaths(nodeDir, `${bare}.ts`)
            : joinPaths(nodeDir, bare, 'index.ts');
    }
}
