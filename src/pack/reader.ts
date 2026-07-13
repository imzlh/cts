import type { ModuleResolver } from '../resolve/index';
import type { PackManifest } from './format';
import { PackSession } from './session';

export interface LoadedPack {
    manifest: PackManifest;
    session: PackSession;
}

/** Map .jspack: one read, decode, lazy 0-copy store. */
export function loadPack(jspackPath: string, resolver: ModuleResolver): LoadedPack {
    const session = PackSession.open(jspackPath);
    session.install(resolver);
    return { manifest: session.manifest, session };
}

export { PackSession, PackBlobStore } from './session';
export type { PackLoadStats } from './session';
