// utils/path.ts — pure path utilities

import { uname } from './index';

const os = import.meta.use('os');

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
    const dir = s.slice(0, i);
    // On Windows, "C:" (without trailing slash) means "current dir on C:",
    // not the root.  Ensure we always return "C:/" for drive-root children.
    if (/^[a-zA-Z]:$/.test(dir)) return dir + '/';
    return dir;
}

export function extname(p: string): string {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
}

export function joinPaths(...parts: string[]): string {
    let out = '';
    for (let p of parts) {
        if (!p) continue;
        p = p.replace(/\\/g, '/');
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
    // Detect drive-letter prefix (e.g. "C:/") as the absolute root
    const driveMatch = p.match(/^([a-zA-Z]:\/)/);
    const prefix = driveMatch ? driveMatch[1]! : (p.startsWith('/') ? '/' : '');
    const abs = prefix.length > 0;
    const rest = p.slice(prefix.length);
    const out: string[] = [];
    for (const s of rest.split('/')) {
        if (!s || s === '.') continue;
        if (s === '..') {
            if (out.length && out.at(-1) !== '..') out.pop();
            else if (!abs) out.push('..');
            // When abs (Unix root or Windows drive root), silently ignore
        } else out.push(s);
    }
    return prefix + out.join('/') || '.';
}

export function resolvePath(...parts: string[]): string {
    let r = joinPaths(...parts);
    if (!isAbsolute(r)) r = joinPaths(String(os.cwd).replace(/\\/g, '/'), r);
    return normalizePath(r);
}

export function isAbsolute(p: string): boolean {
    if (p.startsWith('/')) return true;
    if (uname.sysname.includes('Windows') && /^[a-zA-Z]:[/\\]/.test(p)) return true;
    return false;
}
