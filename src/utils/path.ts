import { uname } from './index';

// Convention: all public functions normalise backslashes to '/' internally.

const os = import.meta.use('os');

function isAsciiAlpha(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function normalizeSlashes(p: string): string {
    let slash = p.indexOf('\\');
    if (slash === -1) return p;
    let out = p.slice(0, slash) + '/';
    let start = slash + 1;
    while ((slash = p.indexOf('\\', start)) !== -1) {
        out += p.slice(start, slash) + '/';
        start = slash + 1;
    }
    return out + p.slice(start);
}

/** True for "/C:..." — a file:// URL's leading slash sitting in front of a Windows drive letter. */
export function hasLeadingSlashDrive(p: string): boolean {
    return p.charCodeAt(0) === 47 /* '/' */ && isAsciiAlpha(p.charCodeAt(1)) && p[2] === ':';
}

/** Convert a Windows-style path to POSIX separators.  No-op on POSIX paths. */
export function toPosixPath(p: string): string {
    return normalizeSlashes(p);
}

/**
 * Canonicalise a path/specifier so a case-insensitive Windows volume cannot
 * split cache keys: backslashes → '/', and a leading drive letter is upper-cased
 * ("c:/x" and "C:/x" are the same file). No-op for paths without a drive prefix.
 */
export function canonicalizePath(p: string): string {
    p = normalizeSlashes(p);
    if (p.length >= 2 && p[1] === ':') {
        const c = p.charCodeAt(0);
        const drive = p[0];
        if (drive !== undefined && c >= 97 && c <= 122) p = drive.toUpperCase() + p.slice(1); // a-z
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
    let s = normalizeSlashes(p);
    if (s.endsWith('/')) s = s.slice(0, -1);
    let r = s.slice(s.lastIndexOf('/') + 1);
    if (ext && r.endsWith(ext)) r = r.slice(0, r.length - ext.length);
    return r;
}

export function dirname(p: string): string {
    const s = normalizeSlashes(p);
    const i = s.lastIndexOf('/');
    if (i <= 0) return i === 0 ? '/' : '.';
    const dir = s.slice(0, i);
    // On Windows, "C:" (without trailing slash) means "current dir on C:",
    // not the root.  Ensure we always return "C:/" for drive-root children.
    if (dir.length === 2 && dir[1] === ':' && isAsciiAlpha(dir.charCodeAt(0))) return dir + '/';
    return dir;
}

export function extname(p: string): string {
    let end = p.length;
    while (end > 0) {
        const c = p.charCodeAt(end - 1);
        if (c !== 47 && c !== 92) break;
        end--;
    }
    let slash = -1, dot = -1;
    for (let i = end - 1; i >= 0; i--) {
        const c = p.charCodeAt(i);
        if (c === 47 || c === 92) {
            slash = i;
            break;
        }
        if (c === 46 && dot === -1) dot = i;
    }
    return dot <= slash + 1 ? '' : p.slice(dot, end);
}

export function joinPaths(...parts: string[]): string {
    let out = '';
    for (let p of parts) {
        if (!p) continue;
        p = normalizeSlashes(p);
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
    p = normalizeSlashes(p);
    if (!p.includes('/.') && !p.includes('./')) return p;
    // Detect drive-letter prefix (e.g. "C:/") as the absolute root
    let prefix = '';
    let start = 0;
    if (p.length >= 3 && p[1] === ':' && p[2] === '/' && isAsciiAlpha(p.charCodeAt(0))) {
        prefix = p.slice(0, 3);
        start = 3;
    } else if (p.startsWith('/')) {
        prefix = '/';
        start = 1;
    }
    const abs = prefix.length > 0;
    const out: string[] = [];
    let segmentStart = start;
    for (let i = start; i <= p.length; i++) {
        if (i !== p.length && p.charCodeAt(i) !== 47) continue;
        const len = i - segmentStart;
        if (len === 0 || (len === 1 && p.charCodeAt(segmentStart) === 46)) {
            segmentStart = i + 1;
            continue;
        }
        if (len === 2 && p.charCodeAt(segmentStart) === 46 && p.charCodeAt(segmentStart + 1) === 46) {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!abs) out.push('..');
            // When abs (Unix root or Windows drive root), silently ignore
        } else {
            out.push(p.slice(segmentStart, i));
        }
        segmentStart = i + 1;
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
