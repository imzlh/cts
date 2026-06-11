// protocol/node.ts - node: builtin module handler

import type { RuntimeConfig, ModuleInfo, NodeBuiltinResolver } from '../types';
import type { ProtocolHandler } from './base';
import { StepType, type Flow } from '../flow';
import { joinPaths, dirname, normalizePath } from '../utils/path';
import { detectFormat } from '../pkg';

import { err, ErrorKind } from '../errors';
import { log } from '../utils/log';

export class NodeHandler implements ProtocolHandler {
    readonly protocols = ['node'];
    private externalResolver: NodeBuiltinResolver | null = null;

    constructor(private readonly cfg: RuntimeConfig) {}

    registerResolver(r: NodeBuiltinResolver): void {
        this.externalResolver = r;
    }

    *resolve(spec: string, parent: string): Flow<ModuleInfo> {
        const bare = spec.startsWith('node:') ? spec.slice(5) : spec;

        if ((bare.startsWith('./') || bare.startsWith('../')) && parent.startsWith('node:')) {
            const parentBare = parent.slice(5);
            const parentDir = parentBare.includes('/') ? dirname(parentBare) : parentBare;
            const resolved = normalizePath(joinPaths(parentDir, bare));
            if (resolved.startsWith('..') || resolved.startsWith('/')) {
                throw err(ErrorKind.ModuleNotFound, `Relative import "${bare}" from "${parent}" escapes module boundary`);
            }
            const localPath = yield* this.findPolyfill(resolved);
            const specPath  = `node:${resolved}`;
            return { specPath, localPath, format: detectFormat(localPath), fileKind: 'source' };
        }

        const specPath  = `node:${bare}`;
        const localPath = yield* this.findPolyfill(bare);
        return { specPath, localPath, format: detectFormat(localPath), fileKind: 'source' };
    }

    localPath(specPath: string): string {
        const bare = specPath.startsWith('node:') ? specPath.slice(5) : specPath;
        if (bare.includes('/')) {
            const parts = bare.split('/');
            const topModule = parts[0]!;
            const lastPart = parts[parts.length - 1]!;
            return joinPaths(this.cfg.cacheDir, 'node', topModule, `${lastPart}.ts`);
        }
        return joinPaths(this.cfg.cacheDir, 'node', bare, 'index.ts');
    }

    private *findPolyfill(bare: string): Flow<string> {
        if (this.externalResolver) {
            const p = this.externalResolver(bare);
            if (p) { log.debug('node', () => `external -> ${p}`); return p; }
        }
        const nodeDir = joinPaths(this.cfg.cacheDir, 'node');
        const localPath = bare.includes('/')
            ? joinPaths(nodeDir, `${bare}.ts`)
            : joinPaths(nodeDir, bare, 'index.ts');
        const exists = yield { type: StepType.FS_EXISTS, path: localPath };
        if (!exists) throw err(ErrorKind.FileNotFound, `Node.js builtin "${bare}" has no polyfill at ${localPath}`);
        return localPath;
    }
}
