import { clearResolveCache, clearNegativeCache, log } from '../utils';
import { clearPkgCache } from '../resolve/pkg';
import { clearDnsCache } from '@cnojs/http/dns-cache';
import { closeConnectionPools } from '../flow';

export interface Cleanup { (): void }

export class ResourceManager {
    private readonly cleanups: Cleanup[] = [];
    private done = false;

    register(fn: Cleanup): void {
        if (this.done) {
            try { fn(); }
            catch (e) { log.debug('resources', 'late cleanup error', e); }
            return;
        }
        this.cleanups.push(fn);
    }

    /** Release all resources in LIFO order. Idempotent. */
    release(): void {
        if (this.done) return;
        this.done = true;

        let cleanup: Cleanup | undefined;
        while ((cleanup = this.cleanups.pop())) {
            try { cleanup(); }
            catch (e) { log.debug('resources', 'cleanup error', e); }
        }
    }

    get released(): boolean { return this.done; }
}

/** ResourceManager with standard pre-cache cleanups. */
export function createResourceManager(): ResourceManager {
    const mgr = new ResourceManager();

    mgr.register(closeConnectionPools);
    mgr.register(clearDnsCache);
    mgr.register(clearPkgCache);

    mgr.register(() => {
        clearResolveCache();
        clearNegativeCache();
    });

    return mgr;
}

// Process-exit cleanup singleton when no TypeScriptRuntime is held.
export const resources = createResourceManager();
