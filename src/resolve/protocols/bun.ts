import type { ModuleInfo, RuntimeConfig } from '../../types';
import { StepType, type Flow } from '../../flow';
import { err, ErrorKind } from '../../errors';
import { joinPaths, resolvePath } from '../../utils/path';
import type { ProtocolHandler } from './base';
import { canonicalBunSpecifier, type BunModule } from '../bun-specifier';

export { BUN_MODULES, canonicalBunSpecifier, isBunSpecifier } from '../bun-specifier';

const PAYLOAD_FILE: Record<BunModule, string> = {
    'bun': 'index.js',
    'bun:sqlite': 'sqlite.js',
};

/** Unknown or malformed `bun:*` name. Never falls back to npm, maps or network. */
export function unknownBunBuiltin(spec: string): Error {
    return err(ErrorKind.ModuleNotFound, `Unknown Bun builtin "${spec}"`,
        undefined, 'ERR_UNKNOWN_BUILTIN_MODULE');
}

function unavailableBunBuiltin(name: BunModule, detail: string): Error {
    return err(ErrorKind.ModuleNotFound, `Bun builtin "${name}" is unavailable: ${detail}`,
        undefined, 'ERR_UNKNOWN_BUILTIN_MODULE');
}

/**
 * `bun` and `bun:sqlite` are ordinary ESM files installed beside the
 * executable (`bunDir/index.js`, `bunDir/sqlite.js`). The canonical specifier
 * stays the module identity; only `localPath` points at the payload. The
 * payloads are self-contained bundles, so they have no relative imports.
 */
export class BunHandler implements ProtocolHandler {
    readonly protocols = ['bun'];
    private readonly root: string | null;

    constructor(cfg: RuntimeConfig) {
        this.root = cfg.bunDir ? resolvePath(cfg.bunDir) : null;
    }

    *resolve(spec: string, _parent: string): Flow<ModuleInfo> {
        const name = canonicalBunSpecifier(spec);
        if (!name) throw unknownBunBuiltin(spec);
        const localPath = this.payloadPath(name);
        const exists = yield { type: StepType.FS_EXISTS, path: localPath };
        if (!exists) throw unavailableBunBuiltin(name, `payload not found at ${localPath}`);
        return { specPath: name, localPath, format: 'esm', fileKind: 'source' };
    }

    localPath(specPath: string): string {
        const name = canonicalBunSpecifier(specPath);
        if (!name) throw unknownBunBuiltin(specPath);
        return this.payloadPath(name);
    }

    private payloadPath(name: BunModule): string {
        if (!this.root) throw unavailableBunBuiltin(name, 'no Bun payload directory is configured');
        return joinPaths(this.root, PAYLOAD_FILE[name]);
    }
}
