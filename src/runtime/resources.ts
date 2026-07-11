import { clearResolveCache, clearNegativeCache, log } from '../utils';
import { clearPkgCache } from '../resolve/pkg';
import { clearDnsCache } from '@cnojs/http/dns-cache';
import { closeConnectionPools } from '../flow';

export interface Cleanup { (): void }

export class ResourceManager {
    private readonly cleanups: Cleanup[] = [];
    private done = false;

    register(fn: Cleanup): void {
        this.cleanups.push(fn);
    }

    /** Release all resources in LIFO order. Idempotent. */
    release(): void {
        if (this.done) return;
        this.done = true;

        for (let i = this.cleanups.length - 1; i >= 0; i--) {
            try { this.cleanups[i]?.(); }
            catch (e) { log.debug('resources', 'cleanup error', e); }
        }
        this.cleanups.length = 0;
    }

    get released(): boolean { return this.done; }
}

/**
 * Create a ResourceManager with standard pre-cache cleanups registered.
 */
export function createResourceManager(): ResourceManager {
    const mgr = new ResourceManager();

    mgr.register(() => {
        closeConnectionPools();
    });

    mgr.register(() => {
        clearDnsCache();
    });

    mgr.register(() => {
        clearPkgCache();
    });

    mgr.register(() => {
        clearResolveCache();
        clearNegativeCache();
    });

    return mgr;
}

// Module-level singleton for process-level cleanup (used by src/main.ts).
// Each TypeScriptRuntime creates its own instance; this one is for
// process exit cleanup when no runtime reference is available.
export const resources = createResourceManager();
