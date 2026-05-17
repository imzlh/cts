// utils/path.ts — pure path utilities

import { os, uname } from './index';

export function basename(p: string, ext?: string): string {
    const s = p.replace(/\\/g, '/').replace(/\/$/, '');
    let r = s.slice(s.lastIndexOf('/') + 1);
    if (ext && r.endsWith(ext)) r = r.slice(0, r.length - ext.length);
    return r;
}

export function dirname(p: string): string {
    const s = p.replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    if (i <= 0) return i === 0 ? '/' : '.';
    return s.slice(0, i);
}

export function extname(p: string): string {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
}

export function joinPaths(...parts: string[]): string {
    let out = '';
    for (const p of parts) {
        if (!p) continue;
        if (!out) { out = p; continue;
        }
        const outSlash = out.endsWith('/');
        const pSlash = p.startsWith('/');
        if (outSlash && pSlash) {
            out += p.slice(1);          // both have / → dedup
        } else if (!outSlash && !pSlash) {
            out += '/' + p;             // neither has / → insert
        } else {
            out += p;                   // exactly one / → concat as-is
        }
    }
    return out;
}

export function normalizePath(p: string): string {
    if (!p.includes('/.') && !p.includes('./')) return p;
    const abs = p.startsWith('/');
    const out: string[] = [];
    for (const s of p.split('/')) {
        if (!s || s === '.') continue;
        if (s === '..') { if (out.length && out.at(-1) !== '..') out.pop(); else if (!abs) out.push('..'); }
        else out.push(s);
    }
    return (abs ? '/' : '') + out.join('/') || '.';
}

export function resolvePath(...parts: string[]): string {
    let r = joinPaths(...parts);
    if (!r.startsWith('/')) r = joinPaths(os.cwd, r);
    return normalizePath(r);
}

export function isAbsolute(p: string): boolean {
    if (p.startsWith('/')) return true;
    if (uname.sysname.includes('Windows') && /^[a-zA-Z]:[/\\]/.test(p)) return true;
    return false;
}
