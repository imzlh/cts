// lock.ts — persistent resolution lock (SQLite3)
//
// Tables:
//   modules: spec TEXT PK, local TEXT, format TEXT, kind TEXT
//   sources: key TEXT PK ("spec\0parent"), spec TEXT
//   bins:    name TEXT PK, path TEXT, pkg TEXT
//
// Performance:
//   - Every statement is prepared → used → finalized per call (safe reuse pattern).
//   - Writes accumulate inside a lazy deferred transaction committed on
//     flush() / rewrite() / close().  For `cno cache` with 500+ modules this
//     turns hundreds of individual INSERTs into a single batch commit.

import type { ModuleInfo, ModuleFormat, FileKind } from './types';
import { joinPaths, dirname } from './utils/path';
import { ensureDir } from './utils/io';
import { log } from './utils/log';
import { errMsg } from './utils';

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

    private db:   CModuleSQLite3.Sqlite3Handle | null = null;
    private inTx = false;
    private loadFailed = false;
    private recoveredInvalidLock = false;
    private readonly dbPath:   string;
    private readonly readOnly: boolean;

    constructor(lockDir: string, readOnly: boolean) {
        this.readOnly = readOnly;
        const dir = lockDir.replace(/\\/g, '/');
        this.dbPath = joinPaths(dir, DB_FILENAME);
    }

    // -------------------------------------------------------------------------
    // Open / schema init
    // -------------------------------------------------------------------------

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

    load(): void {
        if (this.db) return;
        if (this.loadFailed) return;

        if (!this.readOnly) {
            try { ensureDir(dirname(this.dbPath)); } catch {}
        }

        try {
            if (this.readOnly) {
                if (fs.exists(this.dbPath)) {
                    this.db = sqlite3.open(this.dbPath, sqlite3.O_READONLY);
                    this.markOpen();
                    log.debug('lock', () => `opened ${this.dbPath}`);
                    return;  // existing DB already has schema
                } else {
                    // no lock yet — use throw-away in-memory DB (read-only mode, no writes)
                    this.db = sqlite3.open('', sqlite3.O_CREATE | sqlite3.O_READWRITE | sqlite3.O_MEMORY);
                }
            } else {
                this.db = sqlite3.open(this.dbPath, sqlite3.O_CREATE | sqlite3.O_READWRITE);
            }
        } catch (e) {
            log.warn('lock', `open failed: ${errMsg(e)}`);
            this.loadFailed = true;
            return;
        }

        try {
            this.db!.exec('PRAGMA journal_mode = WAL');
            this.db!.exec('PRAGMA synchronous = NORMAL');
            this.db!.exec('PRAGMA cache_size = -8000');
            this.db!.exec('PRAGMA temp_store = MEMORY');
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
        for (const suffix of ['-wal', '-shm']) {
            try {
                const p = this.dbPath + suffix;
                if (fs.exists(p)) fs.unlink(p);
            } catch {}
        }
    }

    // -------------------------------------------------------------------------
    // Helpers — prepare → use → finalize per call (avoids statement-reuse bugs)
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Lazy write transaction — BEGIN on first write, COMMIT on flush/rewrite/close
    // -------------------------------------------------------------------------

    private beginTx(): void {
        if (this.inTx || !this.db) return;
        try { this.db.exec('BEGIN DEFERRED'); this.inTx = true; } catch {}
    }

    private commitTx(): void {
        if (!this.inTx || !this.db) return;
        try { this.db.exec('COMMIT'); } catch (e) {
            try { this.db.exec('ROLLBACK'); } catch {}
            log.warn('lock', `commit failed: ${e}`);
        }
        this.inTx = false;
    }

    private rollbackTx(): void {
        if (!this.inTx || !this.db) return;
        try { this.db.exec('ROLLBACK'); } catch {}
        this.inTx = false;
    }

    // -------------------------------------------------------------------------
    // Read
    // -------------------------------------------------------------------------

    getModule(sp: string): ModuleInfo | undefined {
        const rows = this.query('SELECT local, fmt, kind FROM modules WHERE spec = ?', [sp]);
        if (!rows.length) return undefined;
        const r = rows[0];
        return { specPath: sp, localPath: r.local, format: r.fmt as ModuleFormat, fileKind: r.kind as FileKind };
    }

    getSource(spec: string, parent: string): string | undefined {
        const rows = this.query('SELECT spec FROM sources WHERE key = ?', [`${spec}\0${parent}`]);
        return rows.length ? rows[0].spec : undefined;
    }

    getBin(name: string): { path: string; pkg: string } | undefined {
        const rows = this.query('SELECT path, pkg FROM bins WHERE name = ?', [name]);
        return rows.length ? { path: rows[0].path, pkg: rows[0].pkg } : undefined;
    }

    // -------------------------------------------------------------------------
    // Write  (all writes accumulate inside a lazy deferred transaction)
    // -------------------------------------------------------------------------

    setModule(info: ModuleInfo): void {
        if (this.readOnly) return;
        this.beginTx();
        this.exec('INSERT OR REPLACE INTO modules (spec, local, fmt, kind) VALUES (?, ?, ?, ?)',
            [info.specPath, info.localPath, info.format, info.fileKind]);
    }

    setSource(spec: string, parent: string, sp: string): void {
        if (this.readOnly) return;
        this.beginTx();
        this.exec('INSERT OR REPLACE INTO sources (key, spec) VALUES (?, ?)',
            [`${spec}\0${parent}`, sp]);
    }

    addBin(name: string, path: string, pkg: string): void {
        if (this.readOnly) return;
        this.beginTx();
        this.exec('INSERT OR REPLACE INTO bins (name, path, pkg) VALUES (?, ?, ?)',
            [name, path, pkg]);
    }

    removeBinsForPackage(pkg: string): void {
        if (this.readOnly) return;
        this.beginTx();
        this.exec('DELETE FROM bins WHERE pkg = ?', [pkg]);
    }

    // -------------------------------------------------------------------------
    // Flush / rewrite / close
    // -------------------------------------------------------------------------

    flush(): void {
        if (!this.db) return;
        this.commitTx();
        if (!this.readOnly) {
            try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
        }
    }

    // Called at end of `cno cache` — commit everything accumulated so far.
    rewrite(): void { this.commitTx(); }

    close(): void {
        const db = this.db;
        if (!db) return;
        this.commitTx();
        try {
            if (!this.readOnly) {
                db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            }
        } catch {}
        try { db.close(); }
        finally {
            this.db = null;
            this.inTx = false;
            LockStore.openStores.delete(this);
        }
    }

    closeFast(): void {
        const db = this.db;
        if (!db) return;
        this.rollbackTx();
        try { db.close(); }
        finally {
            this.db = null;
            this.inTx = false;
            LockStore.openStores.delete(this);
        }
    }

    // -------------------------------------------------------------------------
    // Metrics
    // -------------------------------------------------------------------------

    get size(): number {
        const rows = this.query('SELECT COUNT(*) AS n FROM modules');
        return rows[0]?.n ?? 0;
    }

    get dirtyCount(): number { return 0; }
}
