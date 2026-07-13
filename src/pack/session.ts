import type { ModuleResolver } from '../resolve/index';
import { PackHandler } from '../resolve/protocols/pack';
import {
    decodePack,
    readBlob,
    readSourceBlob,
    type PackContainer,
    type PackManifest,
    type PackModuleEntry,
} from './format';
import { log } from '../utils';
import { setActiveFileStore, type VirtualFileStore } from '../utils/memfs';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

export interface PackLoadStats {
    modules: number;
    bytes: number;
    readMs: number;
    decodeMs: number;
    totalMs: number;
}

/**
 * Lazy 0-copy views into one mapped .jspack.
 * has/get/bytecode only subarray — no per-module copies.
 * Lifetime: container.blob (and thus all views) share the mapped ArrayBuffer.
 */
export class PackBlobStore implements VirtualFileStore {
    private readonly container: PackContainer;
    private readonly abiOk: boolean;

    constructor(container: PackContainer) {
        this.container = container;
        this.abiOk = container.manifest.bytecodeVersion === engine.versions.quickjs;
    }

    has(path: string): boolean {
        return this.entry(path) !== undefined;
    }

    /** Source fallback or non-source asset (0-copy). */
    get(path: string): Uint8Array | undefined {
        const entry = this.entry(path);
        if (!entry) return undefined;
        return entry.fileKind === 'source'
            ? readSourceBlob(this.container, entry)
            : readBlob(this.container, entry);
    }

    /**
     * ABI-matching non-sourceOnly bytecode (0-copy).
     * Absent → loaders recompile from get() source.
     */
    bytecode(path: string): Uint8Array | undefined {
        const entry = this.entry(path);
        if (!entry || entry.fileKind !== 'source' || entry.sourceOnly || !this.abiOk) {
            return undefined;
        }
        return readBlob(this.container, entry);
    }

    private entry(path: string): PackModuleEntry | undefined {
        const modules = this.container.manifest.modules;
        // hasOwnProperty: JSON manifest must not inherit Object.prototype traps.
        return Object.prototype.hasOwnProperty.call(modules, path) ? modules[path] : undefined;
    }
}

/**
 * Mapped .jspack lifetime:
 *   open()    — 1× readFile + decode (range-validated). No per-module work.
 *   install() — process-wide PackBlobStore + pack: handler.
 * First load: JscCache → store.bytecode() → deserialize(view), else get() source.
 */
export class PackSession {
    readonly manifest: PackManifest;
    readonly store: PackBlobStore;
    readonly stats: PackLoadStats;
    private installed = false;

    private constructor(
        manifest: PackManifest,
        store: PackBlobStore,
        stats: PackLoadStats,
    ) {
        this.manifest = manifest;
        this.store = store;
        this.stats = stats;
    }

    static open(jspackPath: string): PackSession {
        const started = Date.now();
        // One map: Uint8Array over fs.readFile ArrayBuffer; decodePack views into it.
        const mapped = new Uint8Array(fs.readFile(jspackPath));
        const readAt = Date.now();
        const container = decodePack(mapped);
        const decodeAt = Date.now();
        return new PackSession(container.manifest, new PackBlobStore(container), {
            modules: Object.keys(container.manifest.modules).length,
            bytes: mapped.byteLength,
            readMs: readAt - started,
            decodeMs: decodeAt - readAt,
            totalMs: decodeAt - started,
        });
    }

    /** Activate lazy store + pack: resolve. Re-install is safe (same store). */
    install(resolver: ModuleResolver): void {
        setActiveFileStore(this.store);
        resolver.registerPackHandler(new PackHandler(this.manifest));
        if (this.installed) return;
        this.installed = true;
        log.debug('pack', () =>
            `map ${this.stats.modules} modules (${this.stats.bytes}B): ` +
            `read=${this.stats.readMs}ms decode=${this.stats.decodeMs}ms ` +
            `total=${this.stats.totalMs}ms`);
    }
}
