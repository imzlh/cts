/**
 * Process-scoped virtual file overlay.
 * Pack installs PackBlobStore (lazy 0-copy subarrays of one mapped buffer).
 */

/** Overlay for synthetic localPaths. get/bytecode should prefer 0-copy views. */
export interface VirtualFileStore {
    has(path: string): boolean;
    get(path: string): Uint8Array | undefined;
    /** Optional bytecode view for on-demand deserialize (0-copy). */
    bytecode?(path: string): Uint8Array | undefined;
    clear?(): void;
}

/** Eager path→bytes map (tests / small overlays). Views may alias retained buffers. */
export class MemoryFileStore implements VirtualFileStore {
    private readonly files = new Map<string, Uint8Array>();
    private readonly retained: Uint8Array[] = [];

    retain(buf: Uint8Array): void {
        this.retained.push(buf);
    }

    set(path: string, bytes: Uint8Array): void {
        this.files.set(path, bytes);
    }

    get(path: string): Uint8Array | undefined {
        return this.files.get(path);
    }

    has(path: string): boolean {
        return this.files.has(path);
    }

    get size(): number {
        return this.files.size;
    }

    clear(): void {
        this.files.clear();
        this.retained.length = 0;
    }
}

let active: VirtualFileStore | null = null;

export function setActiveFileStore(store: VirtualFileStore | null): void {
    if (active === store) return;
    active?.clear?.();
    active = store;
}

export function getActiveFileStore(): VirtualFileStore | null {
    return active;
}

/** True when a process-wide VFS overlay is installed (pack / tests). */
export function hasActiveFileStore(): boolean {
    return active !== null;
}

export function hasMemoryFile(path: string): boolean {
    return active?.has(path) === true;
}

export function getMemoryFile(path: string): Uint8Array | undefined {
    return active?.get(path);
}

/** 0-copy bytecode view from the active store, if provided. */
export function getMemoryBytecode(path: string): Uint8Array | undefined {
    return active?.bytecode?.(path);
}
