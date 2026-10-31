import { getInternalBridge } from './internal-registry';

export interface NodeModuleInteropBridge {
    getCache?: () => Record<string, unknown>;
    getExtensions?: () => Record<string, unknown>;
    setCache?: (value: Record<string, unknown>) => void;
    setExtensions?: (value: Record<string, unknown>) => void;
    /** Notify CTS when Node replaces its process-wide cache/extension tables. */
    replaceCache?: (value: Record<string, unknown>) => void;
    /** Restore the default cache, optionally seeded from its detached view. */
    resetCache?: (value?: Record<string, unknown>) => void;
    replaceExtensions?: (value: Record<string, unknown>) => void;
    resetExtensions?: () => void;
    cacheIsDefault?: () => boolean;
    extensionsAreDefault?: () => boolean;
    defaultExtensions?: Record<string, unknown>;
}

export function getNodeModuleInterop(): NodeModuleInteropBridge | undefined {
    return getInternalBridge()?.nodeModuleInterop as NodeModuleInteropBridge | undefined;
}
