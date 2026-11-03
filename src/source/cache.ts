import { dirname, joinPaths, ensureDir, log, canonicalizePath, normalizePath, isPathWithin } from '../utils';
import { getMemoryBytecode, hasActiveFileStore, hasMemoryFile } from '../utils/memfs';
import { writeAtomically } from '../pack/integrity';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

function unlinkIfExists(path: string): void {
    try {
        fs.unlink(path);
    } catch {}
}

function removeCacheFiles(paths: { jsc: string; mt: string }): void {
    unlinkIfExists(paths.jsc);
    unlinkIfExists(paths.mt);
}

// The sidecar also authenticates the bytecode.  The two files are replaced
// separately, so a reader can otherwise observe a sidecar from one writer and
// bytecode from another writer.
const FRESHNESS_VERSION = 'jsc-v5';

export interface SourceFreshness {
    mtim: string;
    size: number;
    /** md5 of the exact source bytes the stamp describes (see sourceDigest). */
    hash: string;
}

/**
 * Bytes + freshness token for one revision; the compiler reuses the read on a
 * miss instead of hashing the file twice.
 */
export interface SourceSnapshot {
    bytes: Uint8Array;
    freshness: SourceFreshness;
}

/** checkFreshness() result: gate verdict plus the capture a compile persists. */
export interface FreshnessCheck {
    fresh: boolean;
    /** Bytes + stamp of the read a stale verdict performed; undefined when the
     *  read was not reached or failed. */
    snapshot?: SourceSnapshot;
}

/** loadCompiled() result: the deserialized value plus the sidecar's verdict on
 *  the contextual Function patch (bytecode cannot be scanned for dynamic
 *  import, so the fresh-compile scan records it for warm loads). */
export interface LoadedCompiled {
    value: unknown;
    patchFunction: boolean;
}

/**
 * Full-precision mtime token: rendering a Date directly loses sub-second
 * precision, which is exactly what a same-second edit exploits.
 */
function mtimeToken(mtim: unknown): string {
    const t = (mtim as Date | undefined)?.getTime?.();
    return typeof t === 'number' && t === t ? String(t) : String(mtim);
}

/**
 * md5 of the source bytes. The stat mtime has second granularity (mod_fs.c
 * builds the Date from st_mtime) and size alone cannot detect a same-size
 * edit, so on every disk hit the content is the authority over the stamp.
 */
function sourceDigest(bytes: CModuleCrypto.BufferSource): string {
    return crypto.hexEncode(crypto.md5(bytes));
}

/**
 * Sidecar stamp: version line, `<mtim>:<size>:<hash>:<patch>`, optional
 * identity line. `<patch>` is the recorded Function-patch verdict; anything but
 * `0` patches, so unknown shapes fall back to the defensive default.
 */
interface SidecarStamp {
    mtim: string;
    size: number;
    hash: string;
    bytecodeHash: string;
    patchFunction: boolean;
    moduleId?: string;
}

function parseSidecar(raw: string): SidecarStamp | undefined {
    const lines = raw.split('\n');
    if (lines[0] !== FRESHNESS_VERSION || lines.length > 3) return undefined;
    const parts = (lines[1] ?? '').split(':');
    if (parts.length !== 5) return undefined;
    const [mtim, size, hash, patch, bytecodeHash] = parts;
    const parsedSize = Number(size);
    if (mtim === undefined || hash === undefined || patch === undefined || bytecodeHash === undefined
        || !Number.isInteger(parsedSize) || parsedSize < 0) return undefined;
    return {
        mtim,
        size: parsedSize,
        hash,
        bytecodeHash,
        patchFunction: patch !== '0',
        moduleId: lines.length === 3 ? lines[2] : undefined,
    };
}

function encodeSidecar(
    revision: SourceFreshness,
    bytecodeHash: string,
    patchFunction: boolean,
    moduleId?: string,
): string {
    const stamp = `${revision.mtim}:${revision.size}:${revision.hash}:${patchFunction ? 1 : 0}:${bytecodeHash}`;
    return moduleId === undefined
        ? `${FRESHNESS_VERSION}\n${stamp}`
        : `${FRESHNESS_VERSION}\n${stamp}\n${encodeURIComponent(moduleId)}`;
}

function stampMatchesIdentity(stamp: SidecarStamp, moduleId?: string): boolean {
    return stamp.moduleId === (moduleId === undefined ? undefined : encodeURIComponent(moduleId));
}

/** Deserialized value is valid but the wrong shape for this caller (see loadRaw). */
const MISMATCH = Symbol('cts.jsc.shapeMismatch');

function memoryKey(localPath: string, moduleId?: string): string {
    return `${localPath}\0${moduleId ?? ''}`;
}

export function isRemote(specPath: string): boolean {
    return specPath.startsWith('http://') || specPath.startsWith('https://')
        || specPath.startsWith('jsr:') || specPath.startsWith('npm:')
        || specPath.startsWith('node:') || specPath.startsWith('pack:')
        || specPath.startsWith('ctsview:');
}

/** True only for real FS paths (not pack:/ctsview:). */
export function isFileBackedPath(localPath: string): boolean {
    if (localPath.startsWith('pack:') || localPath.startsWith('ctsview:')) return false;
    // Skip VFS has() when no overlay is installed (common disk-only runs).
    if (hasActiveFileStore() && hasMemoryFile(localPath)) return false;
    return true;
}

export class JscCache {
    /** Optional owned L1 buffers (precompile); pack uses VFS bytecode() instead. */
    private readonly memory = new Map<string, ArrayBuffer>();
    /** Source bytes observed by a disk-cache miss; consumed by the compiler. */
    private readonly sourceSnapshots = new Map<string, SourceSnapshot>();
    private readonly localDir: string | null;
    private readonly cacheRoot: string | null;
    /** realpath(cacheRoot), resolved once; undefined until first needed. */
    private ownedRoot: string | undefined;

    constructor(cacheDir?: string) {
        this.cacheRoot = cacheDir ? canonicalizePath(normalizePath(cacheDir)) : null;
        this.localDir = this.cacheRoot ? joinPaths(this.cacheRoot, 'local') : null;
    }

    // Local cache path: {cacheDir}/local/{hash[0:2]}/{hash}.jsc

    private localCachePath(localPath: string): { jsc: string; mt: string } | null {
        if (!this.localDir || !isFileBackedPath(localPath)) return null;
        const hash = crypto.hexEncode(crypto.md5(engine.encodeString(localPath)));
        const dir = joinPaths(this.localDir, hash.slice(0, 2));
        const base = joinPaths(dir, hash);
        return { jsc: base + '.jsc', mt: base + '.jsc.mt' };
    }

    // Load: L1 (memory) → L2 (disk .jsc) → null

    private remoteCachePaths(localPath: string): { jsc: string; mt: string } | null {
        if (!isFileBackedPath(localPath)) return null;
        const jsc = localPath + '.jsc';
        return { jsc, mt: jsc + '.mt' };
    }

    /** Keep adjacent remote bytecode inside the configured cache root. */
    private isCacheOwnedPath(localPath: string): boolean {
        // Direct JscCache consumers without a root have no isolated cache;
        // adjacent remote files remain the only storage.
        if (!this.cacheRoot) return true;
        if (this.ownedRoot === undefined) {
            let root = this.cacheRoot;
            try { root = canonicalizePath(normalizePath(fs.realpath(root))); } catch {}
            // The cache root does not move within a run.
            this.ownedRoot = root;
        }
        const normalized = canonicalizePath(normalizePath(localPath));
        // A symlink may be retargeted while this cache instance is alive. Do
        // not memoize this lookup or ownership can remain tied to its old
        // target and write adjacent bytecode into the wrong cache root.
        let target = normalized;
        try { target = canonicalizePath(normalizePath(fs.realpath(localPath))); } catch {}
        return isPathWithin(this.ownedRoot, target);
    }

    /** Select adjacent remote storage or an isolated local hashed cache. */
    private cachePaths(localPath: string, remote: boolean): { jsc: string; mt: string } | null {
        if (remote && this.isCacheOwnedPath(localPath)) return this.remoteCachePaths(localPath);
        return this.localCachePath(localPath);
    }

    /** Take the source read performed by the preceding cache lookup. */
    takeSourceSnapshot(localPath: string, moduleId?: string): SourceSnapshot | undefined {
        const key = memoryKey(localPath, moduleId);
        const snapshot = this.sourceSnapshots.get(key);
        this.sourceSnapshots.delete(key);
        return snapshot;
    }

    /** Stat + read + hash in one pass: the freshness capture for a read. */
    readSource(localPath: string): SourceSnapshot | undefined {
        try {
            return this.snapshotRevision(localPath, fs.stat(localPath));
        } catch {
            return undefined;
        }
    }

    captureFreshness(localPath: string): SourceFreshness | undefined {
        return this.readSource(localPath)?.freshness;
    }

    private snapshotRevision(localPath: string, stat: ReturnType<typeof fs.stat>): SourceSnapshot | undefined {
        try {
            const bytes = new Uint8Array(fs.readFile(localPath));
            // size+hash describe the read bytes; mtime comes from the stat taken
            // before them, so persisting this snapshot never re-stats after a
            // compile could have observed an edit.
            return {
                bytes,
                freshness: { mtim: mtimeToken(stat.mtim), size: bytes.byteLength, hash: sourceDigest(bytes) },
            };
        } catch {
            return undefined;
        }
    }

    private readStamp(mtPath: string): SidecarStamp | undefined {
        try {
            return parseSidecar(engine.decodeString(fs.readFile(mtPath)));
        } catch {
            return undefined;
        }
    }

    private writeMtime(
        mtPath: string,
        moduleId: string | undefined,
        revision: SourceFreshness,
        bytecodeHash: string,
        patchFunction: boolean,
    ): void {
        writeAtomically(
            mtPath,
            engine.encodeString(encodeSidecar(revision, bytecodeHash, patchFunction, moduleId)),
            ensureDir,
        );
    }

    private writeCacheFile(
        paths: { jsc: string; mt: string },
        localPath: string,
        bytecode: ArrayBuffer,
        moduleId?: string,
        source?: SourceFreshness,
        patchFunction = true,
    ): void {
        ensureDir(dirname(paths.jsc));
        writeAtomically(paths.jsc, new Uint8Array(bytecode), ensureDir);
        // Production callers pass the freshness captured before compiling; the
        // fallback describes the current revision for snapshot-less callers.
        const revision = source ?? this.readSource(localPath)?.freshness;
        if (revision) {
            // The sidecar is written after the bytecode and records its digest.
            // A reader that crosses the two replacement windows therefore
            // rejects the pair instead of deserializing the wrong module.
            const bytecodeHash = sourceDigest(bytecode);
            this.writeMtime(paths.mt, moduleId, revision, bytecodeHash, patchFunction);
        }
    }

    load(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): CModuleEngine.Module | null {
        return this.loadRaw(localPath, remote, cachedMtime, moduleId, true) as CModuleEngine.Module | null;
    }

    /** load() for non-Module values (e.g. EVAL_COMPILE_ONLY); raw deserialize. */
    loadCompiled(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): LoadedCompiled | null {
        return this.loadRaw(localPath, remote, cachedMtime, moduleId, false) as LoadedCompiled | null;
    }

    private loadRaw(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
        wantModule = true,
    ): unknown | null {
        // CJS-wrapper and ESM bytecode share one identity for a file loaded both
        // ways (--require of an ESM-format .js); a shape mismatch is a cache miss.
        // MISMATCH keeps the entry (it is valid for the other consumer); only a
        // failed deserialize (corrupt / ABI change) clears the files.
        const accept = (value: unknown): unknown =>
            (value instanceof engine.Module) === wantModule ? value : MISMATCH;
        const serve = (mod: unknown, patchFunction: boolean): unknown =>
            wantModule ? mod : { value: mod, patchFunction };

        // L1a: owned buffers (precompile one-shot)
        const key = memoryKey(localPath, moduleId);
        // Do not let an unconsumed miss from an earlier lookup survive a retry
        // or an L1 hit for the same identity.
        this.sourceSnapshots.delete(key);
        const bc = this.memory.get(key);
        if (bc) {
            try {
                const mod = accept(engine.deserialize(new Uint8Array(bc)));
                this.memory.delete(key);
                if (mod !== MISMATCH) return serve(mod, true);
            } catch {
                log.debug('jsc', () => `memory deserialize failed: ${localPath}`);
                this.memory.delete(key);
            }
        }

        // L1b: active VFS bytecode() — 0-copy view, deserialize on demand.
        // engine.deserialize is typed as ArrayBuffer-backed (not SharedArrayBuffer);
        // pack/VFS views are subarrays of that kind — re-wrap without copying when possible.
        const view = getMemoryBytecode(localPath);
        if (view) {
            try {
                const buf = view.buffer;
                const bytes = buf instanceof ArrayBuffer
                    ? new Uint8Array(buf, view.byteOffset, view.byteLength)
                    : new Uint8Array(view);
                const mod = accept(engine.deserialize(bytes));
                if (mod !== MISMATCH) return serve(mod, true);
            } catch {
                log.debug('jsc', () => `vfs bytecode deserialize failed: ${localPath}`);
                // Fall through: source recompile (ABI mismatch / corrupt blob).
            }
        }

        // L2: on-disk only for real filesystem paths. One stat feeds the
        // revision stamp; the bytes it reads are the content the miss path
        // persists.
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return null;
        let stat: ReturnType<typeof fs.stat>;
        try {
            stat = fs.stat(localPath);
        } catch {
            return null;
        }
        const readRevision = (): SourceSnapshot | undefined => this.snapshotRevision(localPath, stat);
        const remember = (snapshot: SourceSnapshot | undefined): void => {
            if (snapshot) this.sourceSnapshots.set(key, snapshot);
        };

        // Sidecar before source: an absent .mt is a cold miss — no unlinks (the
        // next persist rewrites both files), but keep the read, since it is the
        // freshness capture the recompile persists. Only a sidecar that exists
        // and disagrees (unparseable or foreign identity) is cleared.
        let rawSidecar: string | undefined;
        try {
            rawSidecar = engine.decodeString(fs.readFile(paths.mt));
        } catch {}
        const stamp = rawSidecar === undefined ? undefined : parseSidecar(rawSidecar);
        if (stamp === undefined || !stampMatchesIdentity(stamp, moduleId)) {
            remember(readRevision());
            if (rawSidecar !== undefined) removeCacheFiles(paths);
            return null;
        }

        // Content identity decides on every disk hit: the native stat exposes
        // second-granularity mtimes (mod_fs.c builds the Date from st_mtime),
        // so a stat-only tier cannot distinguish a same-second same-size edit.
        // The read+hash IS the freshness authority, and the read doubles as
        // the snapshot the recompile persists on a miss. A resolver-supplied
        // mtime (e.g. -1) must still agree with the stamp to keep its
        // invalidation power.
        const snapshot = readRevision();
        const mtimOk = cachedMtime === undefined || mtimeToken(cachedMtime) === stamp.mtim;
        if (!snapshot
            || !mtimOk
            || snapshot.freshness.size !== stamp.size
            || snapshot.freshness.hash !== stamp.hash) {
            remember(snapshot);
            removeCacheFiles(paths);
            return null;
        }
        try {
            const bytecode = new Uint8Array(fs.readFile(paths.jsc));
            // Do not re-read the sidecar here. Its bytecode digest makes this
            // one sidecar read a coherent generation check even if another
            // writer replaced either file after the read.
            if (sourceDigest(bytecode) !== stamp.bytecodeHash) {
                remember(snapshot);
                return null;
            }
            const mod = accept(engine.deserialize(bytecode));
            if (mod !== MISMATCH) return serve(mod, stamp.patchFunction);
            remember(snapshot);
            return null;
        } catch {
            log.debug('jsc', () => `disk deserialize failed: ${paths.jsc}`);
        }
        remember(snapshot);
        removeCacheFiles(paths);
        return null;
    }

    /** Freshness without deserializing (precache gate). */
    hasFresh(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): boolean {
        return this.checkFreshness(localPath, remote, cachedMtime, moduleId).fresh;
    }

    /**
     * hasFresh plus the stale-path source capture in one stat/read/hash pass.
     * A fresh verdict still reads and hashes the source — content is the
     * authority on every disk hit — and the read it performs IS the capture
     * the caller must persist: running hasFresh and captureFreshness back to
     * back would read and hash the source twice.
     */
    checkFreshness(
        localPath: string,
        remote: boolean,
        cachedMtime?: number,
        moduleId?: string,
    ): FreshnessCheck {
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return { fresh: false };
        try {
            try {
                fs.stat(paths.jsc);
            } catch {
                return { fresh: false, snapshot: this.readSource(localPath) };
            }
            const stamp = this.readStamp(paths.mt);
            if (!stamp || !stampMatchesIdentity(stamp, moduleId)) {
                return { fresh: false, snapshot: this.readSource(localPath) };
            }
            const stat = fs.stat(localPath);
            // Content hash decides on every check: native stat mtimes have
            // second granularity (mod_fs.c builds the Date from st_mtime), so
            // the stat alone cannot clear a same-size edit landed within the
            // same second. The read doubles as the stale-path capture the
            // caller persists. A resolver-supplied mtime must still agree
            // with the stamp to keep its invalidation power — and that path
            // captures too, so the caller can never fall back to a
            // post-compile read that could bless a pre-edit revision.
            if (cachedMtime !== undefined && mtimeToken(cachedMtime) !== stamp.mtim) {
                return { fresh: false, snapshot: this.snapshotRevision(localPath, stat) };
            }
            const snapshot = this.snapshotRevision(localPath, stat);
            if (!snapshot) return { fresh: false };
            let bytecodeHash: string;
            try {
                bytecodeHash = sourceDigest(new Uint8Array(fs.readFile(paths.jsc)));
            } catch {
                return { fresh: false, snapshot };
            }
            return {
                fresh: snapshot.freshness.size === stamp.size
                    && snapshot.freshness.hash === stamp.hash
                    && bytecodeHash === stamp.bytecodeHash,
                snapshot,
            };
        } catch {
            return { fresh: false };
        }
    }

    clearMemory(): void {
        this.memory.clear();
        this.sourceSnapshots.clear();
    }

    setMemory(localPath: string, bc: ArrayBuffer, moduleId?: string): void {
        this.memory.set(memoryKey(localPath, moduleId), bc);
    }

    persistBytecode(
        localPath: string,
        bc: ArrayBuffer,
        remote: boolean,
        moduleId?: string,
        source?: SourceFreshness,
        patchFunction = true,
    ): void {
        const paths = this.cachePaths(localPath, remote);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc, moduleId, source, patchFunction);
        } catch (e) { log.warn('jsc', `persistBytecode failed: ${paths.jsc}`, e); }
    }

    persistMemory(localPath: string, moduleId?: string): void {
        const bc = this.memory.get(memoryKey(localPath, moduleId));
        if (!bc) return;
        const paths = this.cachePaths(localPath, true);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, bc, moduleId);
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    persist(localPath: string, mod: CModuleEngine.Module, moduleId?: string, source?: SourceFreshness): void {
        const paths = this.cachePaths(localPath, true);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump(), moduleId, source);
        } catch (e) {
            log.warn('jsc', `persist failed: ${paths.jsc}`, e);
        }
    }

    persistLocal(localPath: string, mod: CModuleEngine.Module, moduleId?: string, source?: SourceFreshness): void {
        const paths = this.cachePaths(localPath, false);
        if (!paths) return;
        try {
            this.writeCacheFile(paths, localPath, mod.dump(), moduleId, source);
            log.debug('jsc', () => `cached local: ${localPath}`);
        } catch (e) {
            log.warn('jsc', `persistLocal failed: ${paths.jsc}`, e);
        }
    }

    clearLocal(): void {
        if (!this.localDir || !fs.exists(this.localDir)) return;
        try {
            for (const entry of fs.readdir(this.localDir)) {
                const p = joinPaths(this.localDir, entry);
                this.removeLocalCacheDir(p);
            }
            log.debug('jsc', () => `cleared local cache: ${this.localDir}`);
        } catch (e) {
            log.debug('jsc', () => `clearLocal failed: ${e}`);
        }
    }

    private removeLocalCacheDir(dir: string): void {
        try {
            if (!fs.stat(dir).isDirectory) return;
            for (const f of fs.readdir(dir)) {
                unlinkIfExists(joinPaths(dir, f));
            }
            try {
                fs.rmdir(dir);
            } catch {
                // Another process may have touched this cache shard.
            }
        } catch {
            // Ignore unreadable shards while clearing best-effort local cache.
        }
    }
}
