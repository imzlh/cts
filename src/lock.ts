import type { ModuleInfo, ModuleFormat, FileKind } from './types';
import { joinPaths, dirname, toPosixPath, ensureDir, errMsg, log, getMemoryTier } from './utils';

const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');

const DB_FILENAME = 'cts.lock';
type LockValue = CModuleSQLite3.SqliteValue;
type LockRow = CModuleSQLite3.SqliteRow;

function unlinkIfExists(path: string): void {
    try {
        if (fs.exists(path)) fs.unlink(path);
    } catch {}
}

function closeDbQuietly(db: CModuleSQLite3.Sqlite3Handle): void {
    try {
        db.close();
    } catch {}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS modules (
    spec  TEXT PRIMARY KEY,
    local TEXT NOT NULL,
    fmt   TEXT NOT NULL,
    kind  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
    key  TEXT PRIMARY KEY,
    spec TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
    spec TEXT PRIMARY KEY,
    deps TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bins (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    pkg  TEXT NOT NULL
);
`;

export class LockStore {
    private static readonly openStores = new Set<LockStore>();

    /** Does a persisted lock file exist in `dir`? Used to decide read-only reuse. */
    static existsAt(dir: string): boolean {
        try {
            return fs.exists(joinPaths(toPosixPath(dir), DB_FILENAME));
        } catch {
            return false;
        }
    }

    /** On-disk path of the lock (may not exist yet when in-memory/read-only). */
    get path(): string { return this.dbPath; }
    /** True when this store persists writes to disk. */
    get writable(): boolean { return !this.readOnly && !this.disabled; }
    /** False for --no-lock / packed runtimes: no SQLite handle is opened. */
    get enabled(): boolean { return !this.disabled; }

    private db: CModuleSQLite3.Sqlite3Handle | null = null;
    private readonly statements = new Map<string, CModuleSQLite3.Sqlite3Stmt>();
    private loadFailed = false;
    private recoveredInvalidLock = false;
    private readonly dbPath: string;
    private readonly readOnly: boolean;
    private readonly disabled: boolean;

    private readonly pendingModules = new Map<string, ModuleInfo>();
    private readonly pendingSources = new Map<string, string>();
    private readonly pendingImports = new Map<string, string[]>();
    private readonly pendingBins = new Map<string, { path: string; pkg: string }>();
    private readonly pendingRemovedBinPkgs = new Set<string>();
    private readonly moduleCache = new Map<string, ModuleInfo | null>();
    private readonly sourceCache = new Map<string, string | null>();
    private readonly importCache = new Map<string, string[] | null>();
    private readonly binCache = new Map<string, { path: string; pkg: string } | null>();

    constructor(lockDir: string, readOnly: boolean, disabled = false) {
        this.readOnly = readOnly;
        this.disabled = disabled;
        const dir = toPosixPath(lockDir);
        this.dbPath = joinPaths(dir, DB_FILENAME);
    }

    static closeAll(): void {
        for (const store of [...LockStore.openStores]) {
            try {
                store.close();
            } catch (e) {
                log.warn('lock', `close failed: ${errMsg(e)}`);
            }
        }
    }

    static closeAllFast(): void {
        for (const store of [...LockStore.openStores]) {
            try {
                store.closeFast();
            } catch (e) {
                log.debug('lock', () => `fast close failed: ${errMsg(e)}`);
            }
        }
    }

    private markOpen(): void {
        LockStore.openStores.add(this);
    }

    private cleanupSidecars(): void {
        for (const suffix of ['-wal', '-shm']) {
            unlinkIfExists(this.dbPath + suffix);
        }
    }

    load(): void {
        if (this.disabled) return;
        if (this.db || this.loadFailed) return;

        if (!this.readOnly) {
            try {
                ensureDir(dirname(this.dbPath));
            } catch {}
            this.cleanupSidecars();
        }

        try {
            if (this.readOnly) {
                if (fs.exists(this.dbPath)) {
                    this.db = sqlite3.open(this.dbPath, sqlite3.O_READONLY);
                    this.markOpen();
                    log.debug('lock', () => `opened ${this.dbPath}`);
                    return;
                }
                this.db = sqlite3.open('', sqlite3.O_CREATE | sqlite3.O_READWRITE | sqlite3.O_MEMORY);
            } else {
                this.db = sqlite3.open(this.dbPath, sqlite3.O_CREATE | sqlite3.O_READWRITE);
            }
        } catch (e) {
            log.warn('lock', `open failed: ${errMsg(e)}`);
            this.loadFailed = true;
            return;
        }

        const db = this.db;
        if (!db) {
            this.loadFailed = true;
            return;
        }

        try {
            db.exec('PRAGMA journal_mode = DELETE');
            db.exec('PRAGMA synchronous = NORMAL');
            db.exec(`PRAGMA cache_size = ${{ low: -256, normal: -2000, high: -8000 }[getMemoryTier()] ?? -2000}`);
            db.exec('PRAGMA temp_store = MEMORY');
            db.exec('PRAGMA busy_timeout = 3000');
            db.exec(SCHEMA);
        } catch (e) {
            log.warn('lock', `schema init failed: ${errMsg(e)}`);
            closeDbQuietly(db);
            this.db = null;
            if (!this.readOnly && !this.recoveredInvalidLock) {
                this.recoveredInvalidLock = true;
                this.backupInvalidLock();
                this.loadFailed = false;
                this.load();
                return;
            }
            this.loadFailed = true;
            return;
        }

        this.markOpen();
        log.debug('lock', () => `opened ${this.dbPath}`);
    }

    private backupInvalidLock(): void {
        const bak = `${this.dbPath}.bak`;
        unlinkIfExists(bak);
        try {
            if (fs.exists(this.dbPath)) fs.rename(this.dbPath, bak);
        } catch {
            unlinkIfExists(this.dbPath);
        }
        this.cleanupSidecars();
    }

    private getDb(): CModuleSQLite3.Sqlite3Handle | null {
        if (this.disabled) return null;
        if (!this.db) this.load();
        return this.db;
    }

    private query(sql: string, params: CModuleSQLite3.SqliteValue[] = []): LockRow[] {
        const db = this.getDb(); if (!db) return [];
        try {
            let stmt = this.statements.get(sql);
            if (!stmt) {
                stmt = db.prepare(sql);
                this.statements.set(sql, stmt);
            }
            return stmt.all(params);
        } catch (e) {
            const stmt = this.statements.get(sql);
            if (stmt) {
                try { stmt.finalize(); } catch {}
                this.statements.delete(sql);
            }
            log.debug('lock', () => `query failed: ${e}`);
            return [];
        }
    }

    private exec(sql: string, params: CModuleSQLite3.SqliteValue[]): void {
        const db = this.getDb(); if (!db) return;
        let stmt = this.statements.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            this.statements.set(sql, stmt);
        }
        stmt.run(params);
    }

    private finalizeStatements(): void {
        for (const stmt of this.statements.values()) {
            try { stmt.finalize(); } catch {}
        }
        this.statements.clear();
    }

    private clearReadCaches(): void {
        this.moduleCache.clear();
        this.sourceCache.clear();
        this.importCache.clear();
        this.binCache.clear();
    }

    private hasPendingWrites(): boolean {
        return this.pendingModules.size > 0
            || this.pendingSources.size > 0
            || this.pendingImports.size > 0
            || this.pendingBins.size > 0
            || this.pendingRemovedBinPkgs.size > 0;
    }

    private clearPendingWrites(): void {
        this.pendingModules.clear();
        this.pendingSources.clear();
        this.pendingImports.clear();
        this.pendingBins.clear();
        this.pendingRemovedBinPkgs.clear();
    }

    private rollbackQuietly(db: CModuleSQLite3.Sqlite3Handle): void {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Preserve the original flush warning; rollback is best-effort.
        }
    }

    private applyPendingWrites(): void {
        if (this.readOnly || !this.hasPendingWrites()) return;
        const db = this.getDb(); if (!db) return;
        try {
            db.exec('BEGIN IMMEDIATE');
            for (const pkg of this.pendingRemovedBinPkgs)
                this.exec('DELETE FROM bins WHERE pkg = ?', [pkg]);
            for (const info of this.pendingModules.values())
                this.exec('INSERT OR REPLACE INTO modules (spec, local, fmt, kind) VALUES (?, ?, ?, ?)',
                    [info.specPath, info.localPath, info.format, info.fileKind]);
            for (const [key, spec] of this.pendingSources)
                this.exec('INSERT OR REPLACE INTO sources (key, spec) VALUES (?, ?)', [key, spec]);
            for (const [spec, deps] of this.pendingImports)
                this.exec('INSERT OR REPLACE INTO imports (spec, deps) VALUES (?, ?)', [spec, JSON.stringify(deps)]);
            for (const [name, bin] of this.pendingBins)
                this.exec('INSERT OR REPLACE INTO bins (name, path, pkg) VALUES (?, ?, ?)',
                    [name, bin.path, bin.pkg]);
            db.exec('COMMIT');
            this.clearPendingWrites();
        } catch (e) {
            this.rollbackQuietly(db);
            log.warn('lock', `flush failed: ${errMsg(e)}`);
        }
    }

    getModule(sp: string): ModuleInfo | undefined {
        const pending = this.pendingModules.get(sp);
        if (pending !== undefined) return pending;
        const cached = this.moduleCache.get(sp);
        if (cached !== undefined) return cached ?? undefined;
        const rows = this.query('SELECT local, fmt, kind FROM modules WHERE spec = ?', [sp]);
        if (!rows.length) {
            this.moduleCache.set(sp, null);
            return undefined;
        }
        const r = rows[0];
        const info = { specPath: sp, localPath: String(r.local), format: r.fmt as ModuleFormat, fileKind: r.kind as FileKind };
        this.moduleCache.set(sp, info);
        return info;
    }

    findModuleSpecsByPrefix(prefix: string): string[] {
        const specs = new Set<string>();
        for (const spec of this.pendingModules.keys()) {
            if (spec.startsWith(prefix)) specs.add(spec);
        }
        const rows = this.query('SELECT spec FROM modules WHERE spec LIKE ?', [`${prefix}%`]);
        for (const row of rows) {
            if (typeof row.spec === 'string') specs.add(row.spec);
        }
        return [...specs];
    }

    getSource(spec: string, parent: string): string | undefined {
        return this.getSourceByKey(`${spec}\0${parent}`);
    }

    getSourceByKey(key: string): string | undefined {
        const pending = this.pendingSources.get(key);
        if (pending !== undefined) return pending;
        const cached = this.sourceCache.get(key);
        if (cached !== undefined) return cached ?? undefined;
        const rows = this.query('SELECT spec FROM sources WHERE key = ?', [key]);
        const spec = rows.length ? String(rows[0].spec) : null;
        this.sourceCache.set(key, spec);
        return spec ?? undefined;
    }

    getBin(name: string): { path: string; pkg: string } | undefined {
        const pending = this.pendingBins.get(name);
        if (pending !== undefined) return pending;
        const cached = this.binCache.get(name);
        if (cached !== undefined) return cached ?? undefined;
        const rows = this.query('SELECT path, pkg FROM bins WHERE name = ?', [name]);
        if (!rows.length) {
            this.binCache.set(name, null);
            return undefined;
        }
        const bin = { path: String(rows[0].path), pkg: String(rows[0].pkg) };
        if (this.pendingRemovedBinPkgs.has(bin.pkg)) {
            this.binCache.set(name, null);
            return undefined;
        }
        this.binCache.set(name, bin);
        return bin;
    }

    getImports(spec: string): string[] | undefined {
        const pending = this.pendingImports.get(spec);
        // Empty [] is a valid warm hit (no static imports) — do not treat as miss.
        // Callers only read; setImports always stores a fresh copy.
        if (pending !== undefined) return pending;
        const cached = this.importCache.get(spec);
        // null = negative miss; [] is a valid positive hit.
        if (cached !== undefined) return cached === null ? undefined : cached;
        const rows = this.query('SELECT deps FROM imports WHERE spec = ?', [spec]);
        if (!rows.length || typeof rows[0].deps !== 'string') {
            this.importCache.set(spec, null);
            return undefined;
        }
        try {
            const deps = JSON.parse(rows[0].deps);
            if (!Array.isArray(deps) || !deps.every(dep => typeof dep === 'string')) {
                this.importCache.set(spec, null);
                return undefined;
            }
            const frozen = Object.freeze(deps) as string[];
            this.importCache.set(spec, frozen);
            return frozen;
        } catch {
            this.importCache.set(spec, null);
            return undefined;
        }
    }

    setModule(info: ModuleInfo): void {
        if (this.readOnly) return;
        this.pendingModules.set(info.specPath, info);
        this.moduleCache.set(info.specPath, info);
    }

    setSource(spec: string, parent: string, sp: string): void {
        this.setSourceByKey(`${spec}\0${parent}`, sp);
    }

    setSourceByKey(key: string, sp: string): void {
        if (this.readOnly) return;
        this.pendingSources.set(key, sp);
        this.sourceCache.set(key, sp);
    }

    setImports(spec: string, deps: string[]): void {
        if (this.readOnly) return;
        // Copy + freeze so getImports can return the cached array without cloning.
        const copy = Object.freeze(deps.slice()) as string[];
        this.pendingImports.set(spec, copy);
        this.importCache.set(spec, copy);
    }

    addBin(name: string, path: string, pkg: string): void {
        if (this.readOnly) return;
        const bin = { path, pkg };
        this.pendingBins.set(name, bin);
        this.binCache.set(name, bin);
    }

    removeBinsForPackage(pkg: string): void {
        if (this.readOnly) return;
        this.pendingRemovedBinPkgs.add(pkg);
        for (const [name, bin] of this.pendingBins) {
            if (bin.pkg === pkg) this.pendingBins.delete(name);
        }
        for (const [name, bin] of this.binCache) {
            if (bin?.pkg === pkg) this.binCache.set(name, null);
        }
    }

    /** Persist pending modules/sources/bins. No-op when read-only or empty. */
    flush(): void {
        this.applyPendingWrites();
    }

    close(): void {
        this.applyPendingWrites();
        const db = this.db;
        if (!db) {
            this.clearPendingWrites();
            this.clearReadCaches();
            if (!this.readOnly) this.cleanupSidecars();
            LockStore.openStores.delete(this);
            return;
        }
        try {
            this.finalizeStatements();
            db.close();
        }
        finally {
            this.db = null;
            this.clearPendingWrites();
            this.clearReadCaches();
            if (!this.readOnly) this.cleanupSidecars();
            LockStore.openStores.delete(this);
        }
    }

    closeFast(): void {
        const db = this.db;
        if (!db) {
            this.clearReadCaches();
            return;
        }
        try {
            this.finalizeStatements();
            db.close();
        }
        finally {
            this.db = null;
            this.clearPendingWrites();
            this.clearReadCaches();
            if (!this.readOnly) this.cleanupSidecars();
            LockStore.openStores.delete(this);
        }
    }

    get size(): number {
        const rows = this.query('SELECT COUNT(*) AS n FROM modules');
        let total = Number(rows[0]?.n ?? 0);
        if (this.pendingModules.size > 0) {
            const existing = new Set<string>();
            const specs = [...this.pendingModules.keys()];
            for (let i = 0; i < specs.length; i += 100) {
                const batch = specs.slice(i, i + 100);
                const placeholders = batch.map(() => '?').join(',');
                const hits = this.query(
                    `SELECT spec FROM modules WHERE spec IN (${placeholders})`, batch
                );
                for (const h of hits) existing.add(String(h.spec));
            }
            for (const key of this.pendingModules.keys()) {
                if (!existing.has(key)) total++;
            }
        }
        return total;
    }

    get dirtyCount(): number {
        return this.pendingModules.size
            + this.pendingSources.size
            + this.pendingImports.size
            + this.pendingBins.size
            + this.pendingRemovedBinPkgs.size;
    }
}
