import type { RuntimeConfig, ModuleInfo, NodeBuiltinResolver } from '../../types';
import type { ProtocolHandler } from './base';
import { StepType, type Flow } from '../../flow';
import { dirname, isPathWithin, joinPaths, normalizePath } from '../../utils/path';

import { err, ErrorKind } from '../../errors';
import { log } from '../../utils/log';

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
            return yield* this.resolveFromNodeParent(bare, parent);
        }

        const specPath  = `node:${bare}`;
        const localPath = yield* this.findPolyfill(bare);
        return { specPath, localPath, format: 'esm', fileKind: 'source' };
    }

    localPath(specPath: string): string {
        const bare = specPath.startsWith('node:') ? specPath.slice(5) : specPath;
        // Cross-tree imports resolved below canonicalise as `node:utils/...`;
        // their physical home is the sibling utils tree, not node/.
        if (bare === 'utils') return joinPaths(this.cfg.cacheDir, 'utils', 'index.ts');
        if (bare.startsWith('utils/')) {
            return joinPaths(this.cfg.cacheDir, `${bare}.ts`);
        }
        if (bare.includes('/')) return joinPaths(this.cfg.cacheDir, 'node', `${bare}.ts`);
        return joinPaths(this.cfg.cacheDir, 'node', bare, 'index.ts');
    }

    /** Relative imports inside a node: polyfill resolve against the parent's
     *  physical location under the setup cache. `../` may climb out of node/
     *  into the sibling utils/ tree that `cno setup` installs — cno/src/node/*
     *  and cno/src/utils/* are sibling trees in the checkout, and the cache
     *  mirrors that layout. Anything outside those two roots is refused, the
     *  same managed-root rule the bun handler applies. */
    private *resolveFromNodeParent(bare: string, parent: string): Flow<ModuleInfo> {
        const parentBare = parent.slice(5);
        const nodeRoot = joinPaths(this.cfg.cacheDir, 'node');
        const utilsRoot = joinPaths(this.cfg.cacheDir, 'utils');

        const parentLocal = parentBare === 'utils'
            ? joinPaths(utilsRoot, 'index.ts')
            : parentBare.startsWith('utils/')
                ? joinPaths(utilsRoot, `${parentBare.slice('utils/'.length)}.ts`)
            : parentBare.includes('/')
                ? joinPaths(nodeRoot, `${parentBare}.ts`)
                : joinPaths(nodeRoot, parentBare, 'index.ts');
        const base = normalizePath(joinPaths(dirname(parentLocal), bare));

        const root = isPathWithin(nodeRoot, base) ? nodeRoot
            : isPathWithin(utilsRoot, base) ? utilsRoot
            : null;
        if (!root) {
            throw err(ErrorKind.ModuleNotFound, `Relative import "${bare}" from "${parent}" escapes module boundary`);
        }

        const relative = base.slice(root.length + 1);
        for (const candidate of [`${relative}.ts`, joinPaths(relative, 'index.ts')]) {
            const localPath = joinPaths(root, candidate);
            const exists = yield { type: StepType.FS_EXISTS, path: localPath };
            if (!exists) continue;
            // utils/ files canonicalise under the node: scheme as `node:utils/...`
            // so they share the node-source pipeline (transform, locks, cache).
            const specPath = root === utilsRoot
                ? `node:utils/${candidate.replace(/\.ts$/, '')}`
                : `node:${candidate.replace(/\.ts$/, '')}`;
            return { specPath, localPath, format: 'esm', fileKind: 'source' };
        }
        throw err(ErrorKind.ModuleNotFound,
            `Cannot resolve "${bare}" from "${parent}" within the polyfill source trees`);
    }

    private *findPolyfill(bare: string): Flow<string> {
        if (this.externalResolver) {
            const p = this.externalResolver(bare);
            if (p) { log.debug('node', () => `external -> ${p}`); return p; }
        }
        const nodeDir = joinPaths(this.cfg.cacheDir, 'node');
        const localPath = bare === 'utils'
            ? joinPaths(this.cfg.cacheDir, 'utils', 'index.ts')
            : bare.startsWith('utils/')
                ? joinPaths(this.cfg.cacheDir, `${bare}.ts`)
                : bare.includes('/')
                    ? joinPaths(nodeDir, `${bare}.ts`)
                    : joinPaths(nodeDir, bare, 'index.ts');
        const exists = yield { type: StepType.FS_EXISTS, path: localPath };
        // ERR_UNKNOWN_BUILTIN_MODULE is what node reports for an unknown
        // `node:` specifier (measured on v24.18.0, both import and require).
        // It survives the ESM boundary's ERR_MODULE_NOT_FOUND upgrade because
        // that only overwrites the generic resolution-miss codes.
        if (!exists) {
            throw err(ErrorKind.FileNotFound,
                `Node.js builtin "${bare}" has no polyfill at ${localPath}`,
                undefined, 'ERR_UNKNOWN_BUILTIN_MODULE');
        }
        return localPath;
    }
}
