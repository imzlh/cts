import type { ModuleResolver } from '../resolve/index';
import type { PackManifest } from './format';
import { PackSession } from './session';

export interface LoadedPack {
    manifest: PackManifest;
    session: PackSession;
}

/**
 * Map a .jspack into the runtime: 1× read, decode, install lazy 0-copy store.
 * No pack-extract, no eager seed, no bytecode copies.
 */
export function loadPack(jspackPath: string, resolver: ModuleResolver): LoadedPack {
    const session = PackSession.open(jspackPath);
    session.install(resolver);
    return { manifest: session.manifest, session };
}

export { PackSession, PackBlobStore } from './session';
export type { PackLoadStats } from './session';
