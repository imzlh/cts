const NAMESPACE = 'cts.internal';
const BRIDGE_KEY = 'bridge';
const BRIDGE_READY = 'bridge-ready';

type InternalBridge = Record<string, unknown>;
type Registry = Pick<typeof CModuleEvBus, 'get' | 'set'> & Partial<Pick<typeof CModuleEvBus, 'emit'>>;

const evbus: Registry | undefined = (() => {
    try {
        const bus = import.meta.use('evbus');
        return bus && typeof bus.get === 'function' && typeof bus.set === 'function' ? bus : undefined;
    } catch {
        return undefined;
    }
})();

function isBridge(value: unknown): value is InternalBridge {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** Realm-local fallback when no bus exists, so repeated calls keep one identity. */
let localBridge: InternalBridge | undefined;

export function getInternalBridge(): InternalBridge | undefined {
    const shared = evbus?.get(NAMESPACE, BRIDGE_KEY);
    if (isBridge(shared)) return shared;
    return localBridge;
}

export function ensureInternalBridge(): InternalBridge {
    const shared = evbus?.get(NAMESPACE, BRIDGE_KEY);
    if (isBridge(shared)) return shared;

    // Rewriting an entry would transfer its owner to the current sandbox.
    if (evbus) {
        const bridge: InternalBridge = {};
        evbus.set(NAMESPACE, BRIDGE_KEY, bridge);
        return bridge;
    }
    return localBridge ??= {};
}

export function notifyInternalBridge(bridge: InternalBridge): void {
    evbus?.emit?.(NAMESPACE, BRIDGE_READY, bridge);
}
