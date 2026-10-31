const NAMESPACE = 'cts.internal';
const BRIDGE_KEY = 'bridge';
const BRIDGE_READY = 'bridge-ready';
const LEGACY_SLOT = Symbol.for('cts.internal');

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

function legacyBridge(): InternalBridge | undefined {
    try {
        const value: unknown = Reflect.get(globalThis, LEGACY_SLOT);
        return isBridge(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

export function getInternalBridge(): InternalBridge | undefined {
    const shared = evbus?.get(NAMESPACE, BRIDGE_KEY);
    return isBridge(shared) ? shared : legacyBridge();
}

export function ensureInternalBridge(): InternalBridge {
    const shared = evbus?.get(NAMESPACE, BRIDGE_KEY);
    const bridge = isBridge(shared) ? shared : (legacyBridge() ?? {});

    // Rewriting an entry would transfer its owner to the current sandbox.
    if (evbus && !isBridge(shared)) evbus.set(NAMESPACE, BRIDGE_KEY, bridge);

    const desc = Object.getOwnPropertyDescriptor(globalThis, LEGACY_SLOT);
    if (!desc || (desc.configurable && (!('value' in desc) || desc.value !== bridge))) {
        Object.defineProperty(globalThis, LEGACY_SLOT, {
            value: bridge, writable: false, enumerable: false, configurable: true,
        });
    }
    return bridge;
}

export function notifyInternalBridge(bridge: InternalBridge): void {
    evbus?.emit?.(NAMESPACE, BRIDGE_READY, bridge);
}
