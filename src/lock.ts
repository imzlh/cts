// lock.ts - persistent resolution lock (SQLite3)
//
// Tables:
//   modules: spec TEXT PK, local TEXT, format TEXT, kind TEXT
//   sources: key TEXT PK (opaque resolver cache key), spec TEXT
//   bins:    name TEXT PK, path TEXT, pkg TEXT
//
// Performance:
//   - Every statement is prepared -> used -> finalized per call.
//   - Writes are staged in memory, then flushed inside a short SQLite
//     transaction on flush() / rewrite() / close().

import type { ModuleInfo, ModuleFormat, FileKind } from './types';
import { joinPaths, dirname, toPosixPath } from './utils/path';
import { ensureDir } from './utils/io';
import { log } from './utils/log';
import { errMsg } from './utils';
import { getMemoryTier } from './utils/tier';

const sqlite3 = import.meta.use('sqlite3');
const fs = import.meta.use('fs');

const DB_FILENAME = 'cts.lock';

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
CREATE TABLE IF NOT EXISTS bins (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    pkg  TEXT NOT NULL
);
`;

export class LockStore {
    private static readonly openStores = new Set<LockStore>();

    private db: CModuleSQLite3.Sqlite3Handle | null = null;
    private loadFailed = false;
    private recoveredInvalidLock = false;
    private readonly dbPath: string;
    private readonly readOnly: boolean;

    private readonly pendingModules = new Map<string, ModuleInfo>();
    private readonly pendingSources = new Map<string, string>();
    private readonly pendingBins = new Map<string, { path: string; pkg: string }>();
    private readonly pendingRemovedBinPkgs = new Set<string>();

    constructor(lockDir: string, readOnly: boolean) {
        this.readOnly = readOnly;
        const dir = toPosixPath(lockDir);
        this.dbPath = joinPaths(dir, DB_FILENAME);
    }

    static closeAll(): void {
        for (const store of [...LockStore.openStores]) {
            try { store.close(); }
            catch (e) { log.warn('lock', `close failed: ${errMsg(e)}`); }
        }
    }

    static closeAllFast(): void {
        for (const store of [...LockStore.openStores]) {
            try { store.closeFast(); }
            catch (e) { log.debug('lock', () => `fast close failed: ${errMsg(e)}`); }
        }
    }

    private markOpen(): void {
        LockStore.openStores.add(this);
    }

    private cleanupSidecars(): void {
        for (const suffix of ['-wal', '-shm']) {
            try {
                const p = this.dbPath + suffix;
                if (fs.exists(p)) fs.unlink(p);
            } catch {}
        }
    }

    load(): void {
        if (this.db || this.loadFailed) return;

        if (!this.readOnly) {
            try { ensureDir(dirname(this.dbPath)); } catch {}
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

        try {
            this.db!.exec('PRAGMA journal_mode = DELETE');
            this.db!.exec('PRAGMA synchronous = NORMAL');
            this.db!.exec(`PRAGMA cache_size = ${{ low: -256, normal: -2000, high: -8000 }[getMemoryTier()] ?? -2000}`);
            this.db!.exec('PRAGMA temp_store = MEMORY');
            this.db!.exec('PRAGMA busy_timeout = 3000');
            this.db!.exec(SCHEMA);
        } catch (e) {
            log.warn('lock', `schema init failed: ${errMsg(e)}`);
            try { this.db!.close(); } catch {}
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
        try { if (fs.exists(bak)) fs.unlink(bak); } catch {}
        try {
            if (fs.exists(this.dbPath)) fs.rename(this.dbPath, bak);
        } catch {
            try { if (fs.exists(this.dbPath)) fs.unlink(this.dbPath); } catch {}
        }
        this.cleanupSidecars();
    }

    private getDb(): CModuleSQLite3.Sqlite3Handle | null {
        if (!this.db) this.load();
        return this.db;
    }

    private query(sql: string, params: any[] = []): any[] {
        const db = this.getDb(); if (!db) return [];
        try {
            const stmt = db.prepare(sql);
            const rows = stmt.all(params);
            stmt.finalize();
            return rows;
        } catch (e) {
            log.debug('lock', () => `query failed: ${e}`);
            return [];
        }
    }

    private exec(sql: string, params: any[]): void {
        const db = this.getDb(); if (!db) return;
        const stmt = db.prepare(sql);
        stmt.run(params);
        stmt.finalize();
    }

    private hasPendingWrites(): boolean {
        return this.pendingModules.size > 0
            || this.pendingSources.size > 0
            || this.pendingBins.size > 0
            || this.pendingRemovedBinPkgs.size > 0;
    }

    private clearPendingWrites(): void {
        this.pendingModules.clear();
        this.pendingSources.clear();
        this.pendingBins.clear();
        this.pendingRemovedBinPkgs.clear();
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
            for (const [name, bin] of this.pendingBins)
                this.exec('INSERT OR REPLACE INTO bins (name, path, pkg) VALUES (?, ?, ?)',
                    [name, bin.path, bin.pkg]);
            db.exec('COMMIT');
            this.clearPendingWrites();
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch {}
            log.warn('lock', `flush failed: ${errMsg(e)}`);
        }
    }

    getModule(sp: string): ModuleInfo | undefined {
        const pending = this.pendingModules.get(sp);
        if (pending) return pending;
        const rows = this.query('SELECT local, fmt, kind FROM modules WHERE spec = ?', [sp]);
        if (!rows.length) return undefined;
        const r = rows[0];
        return { specPath: sp, localPath: r.local, format: r.fmt as ModuleFormat, fileKind: r.kind as FileKind };
    }

    getSource(spec: string, parent: string): string | undefined {
        return this.getSourceByKey(`${spec}\0${parent}`);
    }

    getSourceByKey(key: string): string | undefined {
        const pending = this.pendingSources.get(key);
        if (pending !== undefined) return pending;
        const rows = this.query('SELECT spec FROM sources WHERE key = ?', [key]);
        return rows.length ? rows[0].spec : undefined;
    }

    getBin(name: string): { path: string; pkg: string } | undefined {
        const pending = this.pendingBins.get(name);
        if (pending) return pending;
        const rows = this.query('SELECT path, pkg FROM bins WHERE name = ?', [name]);
        if (!rows.length) return undefined;
        const bin = { path: rows[0].path, pkg: rows[0].pkg };
        if (this.pendingRemovedBinPkgs.has(bin.pkg)) return undefined;
        return bin;
    }

    setModule(info: ModuleInfo): void {
        if (this.readOnly) return;
        this.pendingModules.set(info.specPath, info);
    }

    setSource(spec: string, parent: string, sp: string): void {
        this.setSourceByKey(`${spec}\0${parent}`, sp);
    }

    setSourceByKey(key: string, sp: string): void {
        if (this.readOnly) return;
        this.pendingSources.set(key, sp);
    }

    addBin(name: string, path: string, pkg: string): void {
        if (this.readOnly) return;
        this.pendingBins.set(name, { path, pkg });
    }

    removeBinsForPackage(pkg: string): void {
        if (this.readOnly) return;
        this.pendingRemovedBinPkgs.add(pkg);
        for (const [name, bin] of this.pendingBins) {
            if (bin.pkg === pkg) this.pendingBins.delete(name);
        }
    }

    flush(): void {
        if (!this.db) return;
        this.applyPendingWrites();
    }

    rewrite(): void {
        this.applyPendingWrites();
    }

    close(): void {
        const db = this.db;
        if (!db) return;
        this.applyPendingWrites();
        try { db.close(); }
        finally {
            this.db = null;
            this.clearPendingWrites();
            if (!this.readOnly) this.cleanupSidecars();
            LockStore.openStores.delete(this);
        }
    }

    closeFast(): void {
        const db = this.db;
        if (!db) return;
        try { db.close(); }
        finally {
            this.db = null;
            this.clearPendingWrites();
            if (!this.readOnly) this.cleanupSidecars();
            LockStore.openStores.delete(this);
        }
    }

    get size(): number {
        const rows = this.query('SELECT COUNT(*) AS n FROM modules');
        let total = rows[0]?.n ?? 0;
        for (const key of this.pendingModules.keys()) {
            if (!this.query('SELECT 1 AS n FROM modules WHERE spec = ?', [key]).length) total++;
        }
        return total;
    }

    get dirtyCount(): number {
        return this.pendingModules.size
            + this.pendingSources.size
            + this.pendingBins.size
            + this.pendingRemovedBinPkgs.size;
    }
}
