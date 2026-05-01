// lock.ts — persistent resolution lock (optimized I/O)
//
// Format: NDJSON v2, one JSON object per line.
//   Module entry: {"s":"specPath","l":"localPath","f":"esm","k":"source"}
//   Source entry: {"q":"spec\0parent","v":"specPath"}
//
// Load: wraps all data lines in [] → single JSON.parse() instead of N calls.
// Flush: opens file with 'a' flag → pure append, never reads existing content.

import type { ModuleInfo, ModuleFormat, FileKind } from './types';
import { joinPaths, dirname } from './utils/path';
import { ensureDir } from './utils/io';
import { log } from './utils/log';
import { fs, engine } from './utils/index';

interface ModuleEntry { s: string; l: string; f: ModuleFormat; k: FileKind }
interface SourceEntry  { q: string; v: string }

const HEADER = '// cts.lock v2\n';

// Fast serialisers for fixed-schema objects — avoids JSON.stringify key overhead
function serMod(i: ModuleInfo): string {
    return `{"s":${JSON.stringify(i.specPath)},"l":${JSON.stringify(i.localPath)},"f":"${i.format}","k":"${i.fileKind}"}\n`;
}
function serSrc(q: string, v: string): string {
    return `{"q":${JSON.stringify(q)},"v":${JSON.stringify(v)}}\n`;
}

export class LockStore {
    readonly modules = new Map<string, ModuleInfo>();
    readonly sources = new Map<string, string>();
    private dirtyMods = new Map<string, ModuleInfo>();
    private dirtySrcs = new Map<string, string>();
    private readonly path: string;

    constructor(lockDir: string, private readonly readOnly: boolean) {
        this.path = joinPaths(lockDir, 'cts.lock');
    }

    // -------------------------------------------------------------------------
    // Load — single JSON.parse for all lines
    // -------------------------------------------------------------------------

    load(): void {
        if (!fs.exists(this.path)) return;
        let raw: string;
        try { raw = engine.decodeString(fs.readFile(this.path)); }
        catch { log.warn('lock', 'read failed'); return; }

        // Collect data lines, wrap in array, parse once
        const lines: string[] = [];
        for (const line of raw.split('\n')) {
            const l = line.trim();
            if (l && !l.startsWith('//')) lines.push(l);
        }
        if (!lines.length) return;

        let rows: Array<ModuleEntry & SourceEntry>;
        try {
            rows = JSON.parse('[' + lines.join(',') + ']');
        } catch {
            // Truncation recovery: parse line by line
            rows = [];
            for (const l of lines) { try { rows.push(JSON.parse(l)); } catch {} }
        }

        let mods = 0, srcs = 0, skip = 0;
        for (const o of rows) {
            if (o.q !== undefined) {
                this.sources.set(o.q, o.v); srcs++;
            } else if (o.s && o.l && o.f && o.k) {
                if (isCachedRemote(o.s) && !fs.exists(o.l)) { skip++; continue; }
                this.modules.set(o.s, { specPath: o.s, localPath: o.l, format: o.f, fileKind: o.k });
                mods++;
            }
        }
        log.debug('lock', () => `loaded ${mods}M ${srcs}S skip=${skip}`);
    }

    getModule(sp: string): ModuleInfo | undefined { return this.modules.get(sp); }
    getSource(spec: string, parent: string): string | undefined { return this.sources.get(`${spec}\0${parent}`); }

    setModule(info: ModuleInfo): void {
        if (this.readOnly || this.modules.has(info.specPath)) return;
        this.modules.set(info.specPath, info);
        this.dirtyMods.set(info.specPath, info);
    }

    setSource(spec: string, parent: string, sp: string): void {
        if (this.readOnly) return;
        const k = `${spec}\0${parent}`;
        if (this.sources.has(k)) return;
        this.sources.set(k, sp);
        this.dirtySrcs.set(k, sp);
    }

    // -------------------------------------------------------------------------
    // Flush — append via fd, no read-back
    // -------------------------------------------------------------------------

    flush(): void {
        if (this.readOnly || (this.dirtyMods.size === 0 && this.dirtySrcs.size === 0)) return;
        try {
            ensureDir(dirname(this.path));
            let chunk = fs.exists(this.path) ? '' : HEADER;
            for (const info of this.dirtyMods.values()) chunk += serMod(info);
            for (const [q, v] of this.dirtySrcs) chunk += serSrc(q, v);

            const fd = fs.open(this.path, 'a');
            try { fs.write(fd, engine.encodeString(chunk)); }
            finally { fs.close(fd); }

            log.debug('lock', () => `flushed ${this.dirtyMods.size}M ${this.dirtySrcs.size}S`);
            this.dirtyMods.clear(); this.dirtySrcs.clear();
        } catch (e) { log.warn('lock', 'flush failed', e); }
    }

    // -------------------------------------------------------------------------
    // Rewrite — sorted, deduplicated (called by `cts cache`)
    // -------------------------------------------------------------------------

    rewrite(): void {
        if (this.readOnly) return;
        try {
            ensureDir(dirname(this.path));
            let out = HEADER;
            for (const i of [...this.modules.values()].sort((a, b) => a.specPath < b.specPath ? -1 : 1))
                out += serMod(i);
            for (const [q, v] of [...this.sources.entries()].sort(([a], [b]) => a < b ? -1 : 1))
                out += serSrc(q, v);
            fs.writeFile(this.path, engine.encodeString(out));
            this.dirtyMods.clear(); this.dirtySrcs.clear();
            log.debug('lock', () => `rewrote ${this.modules.size}M ${this.sources.size}S`);
        } catch (e) { log.warn('lock', 'rewrite failed', e); }
    }

    get size(): number { return this.modules.size; }
    get dirtyCount(): number { return this.dirtyMods.size + this.dirtySrcs.size; }
}

function isCachedRemote(sp: string): boolean {
    return sp.startsWith('npm:') || sp.startsWith('jsr:') || sp.startsWith('http:') || sp.startsWith('https:') || sp.startsWith('data:');
}
