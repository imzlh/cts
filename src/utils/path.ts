// utils/path.ts — pure path utilities
//
// Convention: all public functions normalise backslashes to '/' internally so
// callers never need to `.replace(/\\/g, '/')` before calling into this module.

import { uname } from './index';

const os = import.meta.use('os');

function isAsciiAlpha(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** True for "/C:..." — a file:// URL's leading slash sitting in front of a Windows drive letter. */
export function hasLeadingSlashDrive(p: string): boolean {
    return p.charCodeAt(0) === 47 /* '/' */ && isAsciiAlpha(p.charCodeAt(1)) && p[2] === ':';
}

/** Convert a Windows-style path to POSIX separators.  No-op on POSIX paths. */
export function toPosixPath(p: string): string {
    return p.includes('\\') ? p.replace(/\\/g, '/') : p;
}

/**
 * Canonicalise a path/specifier so a case-insensitive Windows volume cannot
 * split cache keys: backslashes → '/', and a leading drive letter is upper-cased
 * ("c:/x" and "C:/x" are the same file). No-op for paths without a drive prefix.
 */
export function canonicalizePath(p: string): string {
    if (p.includes('\\')) p = p.replace(/\\/g, '/');
    if (p.length >= 2 && p[1] === ':') {
        const c = p.charCodeAt(0);
        if (c >= 97 && c <= 122) p = p[0]!.toUpperCase() + p.slice(1); // a-z
    }
    return p;
}

/** Return the current working directory, always with POSIX separators. */
export function cwd(): string {
    return toPosixPath(String(os.cwd));
}

/**
 * Return the filesystem root for the given path.
 *   POSIX      → '/'
 *   Windows    → 'C:/' (or 'D:/' etc.)
 */
export function pathRoot(p: string): string {
    const s = toPosixPath(p);
    if (s.length >= 3 && s[1] === ':' && s[2] === '/' && isAsciiAlpha(s.charCodeAt(0))) {
        return s.slice(0, 2) + '/';
    }
    return '/';
}

export function basename(p: string, ext?: string): string {
    let s = p.includes('\\') ? p.replace(/\\/g, '/') : p;
    if (s.endsWith('/')) s = s.slice(0, -1);
    let r = s.slice(s.lastIndexOf('/') + 1);
    if (ext && r.endsWith(ext)) r = r.slice(0, r.length - ext.length);
    return r;
}

export function dirname(p: string): string {
    const s = p.includes('\\') ? p.replace(/\\/g, '/') : p;
    const i = s.lastIndexOf('/');
    if (i <= 0) return i === 0 ? '/' : '.';
    const dir = s.slice(0, i);
    // On Windows, "C:" (without trailing slash) means "current dir on C:",
    // not the root.  Ensure we always return "C:/" for drive-root children.
    if (dir.length === 2 && dir[1] === ':' && isAsciiAlpha(dir.charCodeAt(0))) return dir + '/';
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
        if (p.includes('\\')) p = p.replace(/\\/g, '/');
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
    // Normalize backslashes first so all subsequent checks work with '/'
    if (p.includes('\\')) p = p.replace(/\\/g, '/');
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
    if (!isAbsolute(r)) r = joinPaths(cwd(), r);
    return normalizePath(r);
}

export function isAbsolute(p: string): boolean {
    if (p.startsWith('/')) return true;
    if (uname.sysname.includes('Windows') && p.length >= 3 && p[1] === ':' && (p[2] === '/' || p[2] === '\\') && isAsciiAlpha(p.charCodeAt(0))) {
        return true;
    }
    return false;
}

/** Check if a specifier is a relative import (./ or ../, with either separator).
 *  Also matches the bare tokens "." and ".." — e.g. require("..") for a
 *  directory-parent import — which have no trailing separator to prefix-match. */
export function isRelative(s: string): boolean {
    return s === '.' || s === '..' ||
        s.startsWith('./') || s.startsWith('../') || s.startsWith('.\\') || s.startsWith('..\\');
}
