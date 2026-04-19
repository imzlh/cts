// utils/misc.ts — hash, semver, tar.gz, JSONC, arg parsing

import { URL } from "../http/url";
import { basename, crypto, dirname, extname, zlib } from './index';

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
export function assert(c: unknown, msg?: string): asserts c {
    if (!c) throw new Error(msg ?? 'Assertion failed');
}

// ---------------------------------------------------------------------------
// Hash — FNV-1a 32-bit (using regular JS numbers, much faster than BigInt)
// Returns 8-char hex string.
// ---------------------------------------------------------------------------

export function hashString(s: string): string {
    let h = 0x811c9dc5;   // FNV offset basis (32-bit)
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        // Multiply by FNV prime (0x01000193), keeping to 32-bit via |0
        h = (Math.imul(h, 0x01000193)) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** Build a stable cache filename from a URL, preserving path structure and extension. */
export function cacheFilename(url: string): string {
    try {
        const u = new URL(url);
        let pathname = u.pathname;
        const dirHash = hashString(pathname).slice(0, 8);
        const name = extname(pathname) || '.js';
        return `${dirHash}${name}`
    } catch {
        return hashString(url);
    }
}

export const isCacheExpired = (ts: number, ttl: number) => Date.now() - ts > ttl;

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

function pad(v: string): [number, number, number, string] {
    const [c = '', pre = ''] = v.split('-');
    const p = c.split('.').map(Number);
    while (p.length < 3) p.push(0);
    return [p[0]!, p[1]!, p[2]!, pre];
}

export function compareVersions(a: string, b: string): number {
    const [a0, a1, a2, ap] = pad(a), [b0, b1, b2, bp] = pad(b);
    const d = a0 - b0 || a1 - b1 || a2 - b2;
    if (d) return d;
    if (!ap && !bp) return 0;
    if (!ap) return 1; if (!bp) return -1;
    return ap.localeCompare(bp);
}

function satisfies(ver: string, range: string): boolean {
    if (!ver || !range) return false;
    const v = pad(ver).slice(0, 3).join('.');
    let r = range.trim();
    if (/^\d+(\.\d+)?$/.test(r)) r += '.x';
    if (/^\d+\.\d+\.\d+$/.test(r)) return compareVersions(v, r) === 0;
    if (r.startsWith('^')) {
        const [M = 0, m = 0, p = 0] = r.slice(1).split('.').map(Number);
        const lo = `${M}.${m}.${p}`;
        const hi = M > 0 ? `${M + 1}.0.0` : `0.${m + 1}.0`;
        return compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0;
    }
    if (r.startsWith('~')) {
        const [M = 0, m = 0, p = 0] = r.slice(1).split('.').map(Number);
        return compareVersions(v, `${M}.${m}.${p}`) >= 0 && compareVersions(v, `${M}.${m + 1}.0`) < 0;
    }
    if (/[x*]/i.test(r)) {
        const pat = r.toLowerCase().split('.');
        const vp  = v.split('.').map(Number);
        for (let i = 0; i < pat.length; i++) {
            if (pat[i] === 'x' || pat[i] === '*') continue;
            if (String(vp[i]) !== pat[i]) return false;
        }
        return true;
    }
    if (r.includes(' - ')) {
        const [lo, hi] = r.split(' - ');
        return compareVersions(v, lo!) >= 0 && compareVersions(v, hi!) <= 0;
    }
    const m = r.match(/^(>=?|<=?|=)\s*(.+)$/);
    if (m) {
        const c = compareVersions(v, m[2]!.trim());
        return m[1] === '>=' ? c >= 0 : m[1] === '>' ? c > 0 :
               m[1] === '<=' ? c <= 0 : m[1] === '<'  ? c < 0 : c === 0;
    }
    return false;
}

export const matchVersion       = (vs: string[], r: string) => vs.filter(v => satisfies(v, r));
export const matchLatestVersion = (vs: string[], r: string): string | null => {
    const ms = matchVersion(vs, r);
    return ms.length ? ms.reduce((a, b) => compareVersions(b, a) > 0 ? b : a) : null;
};

// ---------------------------------------------------------------------------
// tar.gz extraction
// ---------------------------------------------------------------------------

export interface TarFile { path: string; content: Uint8Array; size: number; type: 'file'|'dir'|'link'|'other' }

export function unTarGz(data: ArrayBuffer | Uint8Array): TarFile[] {
    const bytes = new Uint8Array(zlib.gunzip(data));
    const str = (off: number, len: number) => {
        let s = ''; for (let i = 0; i < len; i++) { const c = bytes[off + i]; if (!c) break; s += String.fromCharCode(c); } return s;
    };
    const oct  = (off: number, len: number) => { const s = str(off, len).trim(); return s ? parseInt(s, 8) : 0; };
    const zero = (off: number) => { for (let i = 0; i < 512; i++) if (bytes[off + i]) return false; return true; };
    const B = 512, files: TarFile[] = [];
    let pos = 0;
    while (pos < bytes.length) {
        if (zero(pos) && (pos + B >= bytes.length || zero(pos + B))) break;
        const name = str(pos, 100), size = oct(pos + 124, 12), flag = str(pos + 156, 1);
        if (!name || size < 0) { pos += B; continue; }
        const start = pos + B;
        files.push({ path: name, content: bytes.slice(start, start + size), size,
            type: ({ '0': 'file', '\0': 'file', '5': 'dir', '2': 'link' } as any)[flag] ?? 'other' });
        pos = start + Math.ceil(size / B) * B;
    }
    return files;
}

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

export function stripJsonc(src: string): string {
    let out = '', inStr = false, quote = '', esc = false, block = false, line = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i]!, n = src[i + 1];
        if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
        if (line)  { if (c === '\n') { line = false; out += c; } continue; }
        if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === quote) inStr = false; continue; }
        if (c === '/' && n === '/') { line = true; i++; continue; }
        if (c === '/' && n === '*') { block = true; i++; continue; }
        if (c === '"' || c === "'") { inStr = true; quote = c; }
        out += c;
    }
    return out;
}

export function safeParse<T = unknown>(json: string): T {
    try { return JSON.parse(json.trim()) as T; }
    catch (e) {
        const msg = (e as SyntaxError).message;
        const m = msg.match(/\(line (\d+) column (\d+)\)/);
        if (m) {
            const ln = +m[1]!;
            const ctx = json.split(/\r?\n/).slice(Math.max(0, ln - 2), ln + 2)
                .map((l, i) => `  ${(i + ln - 1).toString().padStart(4)} | ${l}`).join('\n');
            throw new Error(msg + '\n' + ctx);
        }
        throw new Error(msg);
    }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

type ArgType = 'string' | 'boolean' | 'number';
type ArgTemplate = Record<string, ArgType>;
type ArgResult<T extends ArgTemplate> = {
    [K in keyof T]?: T[K] extends 'string' ? string : T[K] extends 'number' ? number : boolean;
} & { _?: string; _args?: string[]; _offset: number };

export function parseArgs<T extends ArgTemplate>(argv: string[], tpl: T): ArgResult<T> {
    const out: any = { _offset: 0 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg.startsWith('--')) {
            const key = arg.slice(2), type = tpl[key], next = argv[i + 1];
            if (!type) { out[key] = true; continue; }
            if (type === 'boolean') { out[key] = true; }
            else if (next && !next.startsWith('--')) {
                out[key] = type === 'number' ? +next : next; i++;
            }
        } else if (arg[0] == '-') {
            for (let j = 1; j < arg.length; j++)
                out[arg[j]!] = true;
        } else {
            out._ = arg;
            out._args = argv.slice(i + 1);
            out._offset = i + 1;
            break;
        }
    }
    return out;
}
