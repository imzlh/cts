// resources.ts — central resource lifecycle
//
// Tracks every resource opened during pre-cache and provides a single
// cleanup() call that must be invoked before user code runs.
//
// Design: explicit cleanup rather than finalizers.
// The pre-cache phase uses:
//   - libcurl ConnPool (async HTTP)
//   - TCP connection pool in net.ts (sync HTTP, used by protocol handlers)
//   - pkg/io resolution caches (may hold stale data from scan phase)
//   - progress timer (setInterval)
// All of these must be released before the user script starts so:
//   - No stale sockets compete with user networking
//   - Caches reflect post-install state
//   - No background timers consume CPU

import { closePool }          from './utils/curl';
import { clearResolveCache }  from './utils/io';
import { clearPkgCache }      from './pkg';
import { connectionManager }  from './http/connection';

import { log } from './utils/log';

export interface Cleanup { (): void }

class ResourceManager {
    private readonly cleanups: Cleanup[] = [];
    private done = false;

    register(fn: Cleanup): void {
        this.cleanups.push(fn);
    }

    /** Release all resources in LIFO order. Idempotent. */
    release(): void {
        if (this.done) return;
        this.done = true;

        // LIFO: last-opened first-closed
        for (let i = this.cleanups.length - 1; i >= 0; i--) {
            try { this.cleanups[i]!(); }
            catch (e) { log.debug('resources', 'cleanup error', e); }
        }
        this.cleanups.length = 0;
    }
}

// Module-level singleton — one per process
const mgr = new ResourceManager();

export const resources = {
    /**
     * Register a cleanup function to be called before user code runs.
     * Called automatically for curl pool, connection pool, caches.
     */
    register: (fn: Cleanup) => mgr.register(fn),

    /**
     * Release everything acquired during the pre-cache phase.
     * Call this exactly once, right before loadEntry().
     */
    release: () => mgr.release(),
};

// ---------------------------------------------------------------------------
// Pre-register the standard pre-cache resources
// These are no-ops if the resources were never opened.
// ---------------------------------------------------------------------------

resources.register(() => {
    // Close libcurl pool (async HTTP used during dep scan)
    closePool();
});

resources.register(() => {
    // Close all keep-alive TCP connections opened by sync fetchBytes()
    // (protocol handlers call this during pre-cache too)
    connectionManager.closeAll();
});

resources.register(() => {
    // Clear pkg/format/exports caches:
    // Pre-cache may have resolved specifiers for files not yet on disk
    // (downloaded to temp locations).  Post-cache, localPaths are final.
    clearPkgCache();
});

resources.register(() => {
    // Clear file resolution cache: same reason as above.
    clearResolveCache();
});
