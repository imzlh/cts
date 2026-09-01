import { isWindows, uname } from './platform';
import { URL } from './url';

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

function invalidFileUrlPath(pathname: string): never {
    const error = new TypeError(`Invalid file URL path: ${pathname}`);
    Object.defineProperty(error, 'code', { value: 'ERR_INVALID_FILE_URL_PATH', enumerable: true });
    throw error;
}

/** Convert a file URL to a normalized CTS POSIX-internal filesystem path. */
export function fileUrlToPath(value: string): string {
    let pathname: string;
    let hostname = '';
    // Older CNO callers formed `file://${windowsPath}`, producing
    // `file://C:/...` or `file://C:\...` instead of the canonical triple slash
    // form. Keep accepting that spelling at this boundary.
    const legacy = value.startsWith('file://') ? value.slice(7) : '';
    if (/^[A-Za-z]:[\\/]/.test(legacy)) {
        const query = legacy.indexOf('?');
        const hash = legacy.indexOf('#');
        const cut = query === -1 ? hash : hash === -1 ? query : Math.min(query, hash);
        pathname = (cut === -1 ? legacy : legacy.slice(0, cut)).replace(/\\/g, '/');
    } else {
        const url = new URL(value);
        if (url.protocol !== 'file:') throw new TypeError('Must be a file URL');
        pathname = url.pathname;
        hostname = url.hostname;
    }
    // A decoded separator would change the URL path structure and is rejected
    // by Node's file URL conversion on Windows. `%5C` is a filename character
    // on POSIX, while `%2F` is always a path separator.
    if (/%2f/i.test(pathname) || (isWindows && /%5c/i.test(pathname))) {
        invalidFileUrlPath(pathname);
    }
    let path = decodeURIComponent(pathname);
    if (!isWindows && hostname && hostname !== 'localhost') {
        throw new TypeError('File URL host must be empty or localhost');
    }
    if (isWindows) {
        if (hostname && hostname !== 'localhost') {
            // Accept the legacy `file://C:/path` spelling used by older CNO
            // callers as well as the canonical `file:///C:/path` form.
            path = /^[A-Za-z]$/.test(hostname)
                ? `${hostname.toUpperCase()}:${path}`
                : `//${hostname}${path}`;
        }
        else if (hasLeadingSlashDrive(path)) path = path.slice(1);
    }
    const trailingSlash = path.endsWith('/');
    const normalized = normalizeDecodedFilePath(path);
    return trailingSlash && normalized !== '/' && !normalized.endsWith('/')
        ? `${normalized}/`
        : normalized;
}

function encodeFileUrlPath(path: string): string {
    return encodeURI(path).replace(/[?#]/g, (char) => char === '#' ? '%23' : '%3F');
}

function normalizeDecodedFilePath(path: string): string {
    // On POSIX, a decoded `\\` is a filename character, not a separator.
    // Keep it opaque while still collapsing URL path dot-segments.
    if (isWindows) {
        return normalizePath(path);
    }
    const absolute = path.startsWith('/');
    const trailingSlash = path.endsWith('/');
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
            else if (!absolute) parts.push('..');
            continue;
        }
        parts.push(part);
    }
    let normalized = `${absolute ? '/' : ''}${parts.join('/')}`;
    if (!normalized) normalized = absolute ? '/' : '.';
    if (trailingSlash && normalized !== '/' && !normalized.endsWith('/')) normalized += '/';
    return normalized;
}

/** Convert a filesystem path to a file URL while retaining CTS path spelling. */
export function toFileUrl(path: string): string {
    const normalized = toPosixPath(path);
    if (isWindows && normalized.startsWith('//?/UNC/')) {
        return `file:${encodeFileUrlPath(`//${normalized.slice('//?/UNC/'.length)}`)}`;
    }
    if (isWindows && normalized.startsWith('//?/')) {
        return `file:///${encodeFileUrlPath(normalized.slice('//?/'.length))}`;
    }
    if (isWindows && normalized.startsWith('//./')) {
        return `file:${encodeFileUrlPath(normalized)}`;
    }
    if (isWindows && /^[A-Za-z]:\//.test(normalized)) {
        return `file:///${encodeFileUrlPath(normalized)}`;
    }
    if (isWindows && /^\/\/[^/]+\/[^/]+/.test(normalized)
        && !normalized.startsWith('//?/') && !normalized.startsWith('//./')) {
        return `file:${encodeFileUrlPath(normalized)}`;
    }
    return normalized.startsWith('/') ? `file://${encodeFileUrlPath(normalized)}` : normalized;
}

/**
 * True for a scheme-qualified id ("pack:/0.js", "npm:foo", "https://x").
 * Requires >= 2 scheme chars so a Windows drive ("C:") is never mistaken for a
 * scheme -- the single-letter trap that made entryUrl() return a raw path.
 */
export function hasSchemeId(s: string): boolean {
    return schemeId(s) !== null;
}

/** Return a normalized scheme name, or null for a filesystem/relative path. */
export function schemeId(s: string): string | null {
    const ci = s.indexOf(':');
    if (ci < 2) return null;
    for (let i = 0; i < ci; i++) {
        const c = s.charCodeAt(i);
        // scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
        const alpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
        if (i === 0 ? !alpha : !(alpha || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return null;
    }
    return s.slice(0, ci).toLowerCase();
}

/**
 * Convert CTS's POSIX-internal paths to native paths at public boundaries.
 * Scheme-qualified IDs stay unchanged because their slashes are identifier syntax, not path separators.
 */
export function toHostPath(p: string): string {
    if (!isWindows || hasSchemeId(p)) return p;
    return p.indexOf('/') === -1 ? p : p.replace(/\//g, '\\');
}

/** toHostPath over an array; `undefined` holes become ''. */
export function toHostPaths(paths: string[]): string[] {
    const out = new Array<string>(paths.length);
    for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        out[i] = p === undefined ? '' : toHostPath(p);
    }
    return out;
}

/** Posix-ish path + upper drive letter so Windows case doesn't split cache keys. */
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

/** FS root: '/' or 'C:/'. */
export function pathRoot(p: string): string {
    const s = toPosixPath(p);
    if (s.length >= 3 && s[1] === ':' && s[2] === '/' && isAsciiAlpha(s.charCodeAt(0))) {
        return s.slice(0, 2) + '/';
    }
    if (isWindows && s.startsWith('//')) {
        // UNC shares are the filesystem root for upward searches. Treat
        // extended UNC and extended drive paths separately from //./pipe/*.
        const deviceNamespace = /^\/\/[?.]\/?$/.exec(s);
        if (deviceNamespace) return deviceNamespace[0].endsWith('/') ? deviceNamespace[0] : `${deviceNamespace[0]}/`;
        const verbatimUnc = /^\/\/[?.]\/UNC\/[^/]+\/[^/]+/i.exec(s);
        if (verbatimUnc) return verbatimUnc[0];
        const verbatimDrive = /^\/\/[?.]\/[A-Za-z]:/i.exec(s);
        if (verbatimDrive) return verbatimDrive[0];
        const unc = /^\/\/[^/]+\/[^/]+/.exec(s);
        if (unc) return unc[0];
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
    if (isWindows && /^\/\/[?.]\/?$/.test(s)) return s.endsWith('/') ? s : `${s}/`;
    if (isWindows && s.startsWith('//')) {
        const root = pathRoot(s);
        const withoutTrailingSlash = s.replace(/\/+$/, '');
        if (withoutTrailingSlash === root) return root;
    }
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
        // A Windows drive path starts a new path boundary. Rooted POSIX-style
        // components retain join semantics, so joinPaths('/a', '/b') is '/a/b'.
        const isDriveAbsolute = isWindows && p.length >= 3 && p[1] === ':' && p[2] === '/' &&
            isAsciiAlpha(p.charCodeAt(0));
        if (isDriveAbsolute) {
            out = p;
            continue;
        }
        if (!out) { out = p; continue;
        }
        if (isWindows && p.startsWith('//')) {
            out = p;
            continue;
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
    if (!p) return '';
    // Protocol specifiers are not filesystem paths: repeated slashes can be
    // significant, and opaque forms such as node:fs must stay untouched.
    const protocol = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p);
    const windowsDrive = /^[A-Za-z]:/.test(p);
    if (protocol && !windowsDrive) return p;
    // Keep the complete Windows root outside the dot-segment stack. In
    // particular, the UNC share is a root just like a drive, and device paths
    // have either a drive root, an extended UNC share, or a device namespace.
    let prefix = '';
    let start = 0;
    if (isWindows) {
        const verbatimUnc = p.match(/^\/\/[?.]\/UNC\/[^/]+\/[^/]+(?=\/|$)/i);
        const verbatimDrive = p.match(/^\/\/[?.]\/[A-Za-z]:/);
        const deviceNamespace = p.match(/^\/\/[?.]\//);
        const deviceRoot = p.match(/^\/\/[?.]\/[^/]+(?=\/|$)/);
        const unc = p.match(/^\/\/[^/]+\/[^/]+(?=\/|$)/);
        if (verbatimUnc) {
            prefix = verbatimUnc[0];
            start = prefix.length;
        } else if (verbatimDrive) {
            prefix = verbatimDrive[0];
            start = prefix.length;
        } else if (deviceRoot) {
            // The namespace's first component is itself a root for paths such
            // as \\.\pipe\name and \\?\GLOBALROOT\Device\...; .. must not
            // walk back through the namespace prefix.
            prefix = deviceRoot[0];
            start = prefix.length;
        } else if (deviceNamespace) {
            prefix = deviceNamespace[0];
            start = prefix.length;
        } else if (unc) {
            prefix = unc[0];
            start = prefix.length;
        } else if (p.length >= 3 && p[1] === ':' && p[2] === '/' && isAsciiAlpha(p.charCodeAt(0))) {
            prefix = p.slice(0, 2);
            start = 3;
        }
    }
    if (!prefix && p.startsWith('/')) {
        prefix = '/';
        start = 1;
    } else if (!prefix && p.length >= 3 && p[1] === ':' && p[2] === '/' && isAsciiAlpha(p.charCodeAt(0))) {
        // POSIX hosts still need to leave a Windows-looking path untouched as
        // a relative name; this branch is only reachable on non-Windows hosts
        // when the input was already classified as a rooted drive path.
        prefix = p.slice(0, 3);
        start = 3;
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
    const body = out.join('/');
    if (!prefix) return body || '.';
    if (prefix.endsWith('/')) return prefix + body;
    if (/^[A-Za-z]:$/.test(prefix)) return body ? `${prefix}/${body}` : `${prefix}/`;
    return body ? `${prefix}/${body}` : prefix;
}

export function resolvePath(...parts: string[]): string {
    let r = joinPaths(...parts);
    if (!isAbsolute(r)) r = joinPaths(cwd(), r);
    return normalizePath(r);
}

/** POSIX-relative path from `base` to `target`, or null if `target` isn't under `base`. */
export function relativePath(base: string, target: string): string | null {
    let b = normalizePath(toPosixPath(base));
    const t = normalizePath(toPosixPath(target));
    if (b !== '/' && b.endsWith('/')) b = b.slice(0, -1);
    const baseKey = isWindows ? b.toLowerCase() : b;
    const targetKey = isWindows ? t.toLowerCase() : t;
    if (targetKey === baseKey) return '';
    const prefix = b === '/' ? '/' : `${b}/`;
    const prefixKey = isWindows ? prefix.toLowerCase() : prefix;
    if (!targetKey.startsWith(prefixKey)) return null;
    return t.slice(prefix.length);
}

/** True when target is base or a lexical descendant of base. */
export function isPathWithin(base: string, target: string): boolean {
    return relativePath(base, target) !== null;
}

export function isAbsolute(p: string): boolean {
    p = toPosixPath(p);
    if (p.startsWith('/')) return true;
    if (isWindows && p.length >= 3 && p[1] === ':' && p[2] === '/' && isAsciiAlpha(p.charCodeAt(0))) {
        return true;
    }
    return false;
}

/** Relative import: ./ ../ . or .. (either separator). */
export function isRelative(s: string): boolean {
    return s === '.' || s === '..' ||
        s.startsWith('./') || s.startsWith('../') || s.startsWith('.\\') || s.startsWith('..\\');
}

/**
 * Parent directory identity for relative (./ ../) resolve/scan caches.
 * Same-dir importers of `./util.js` must share one key. Handles file://,
 * Windows /C:…, and scheme parents (npm:/pack:…); no slash → keep full parent.
 */
export function parentDirKey(parent: string): string {
    let base = parent;
    if (schemeId(base) === 'file') base = fileUrlToPath(base);
    const dir = dirname(base);
    // dirname('npm:pkg@1') is '.' — keep the whole parent ref.
    return dir === '.' ? base : dir;
}
