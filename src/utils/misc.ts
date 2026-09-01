import { extname } from './path';
import { err, ErrorKind } from '../errors';
import { URL } from './url';

const crypto = import.meta.use('crypto');
const zlib = import.meta.use('zlib');

export const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
export function assert(c: unknown, msg?: string): asserts c {
    if (!c) throw err(ErrorKind.Generic, msg ?? 'Assertion failed');
}

// Hash — FNV-1a 32-bit (using regular JS numbers, much faster than BigInt)
// Returns 8-char hex string.

export function hashString(s: string): string {
    let h = 0x811c9dc5;   // FNV offset basis (32-bit)
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        // Multiply by FNV prime (0x01000193), keeping to 32-bit via |0
        h = (Math.imul(h, 0x01000193)) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

export function isValidNpmPackageName(name: string): boolean {
    if (!name || name.length > 214 || name.includes('\\') || name.includes('\0')) return false;
    const parts = name.startsWith('@') ? name.slice(1).split('/') : [name];
    if (name.startsWith('@') ? parts.length !== 2 : name.includes('/')) return false;
    for (const part of parts) {
        if (!part || part === '.' || part === '..' || part.includes(':') ||
            /[\u0000-\u0020\u007f]/.test(part)) return false;
    }
    return true;
}

/** A dependency edge after npm alias syntax has been resolved. */
export interface NpmDepTarget {
    /** Name the parent imports/links the dep under — the package.json key. */
    linkName: string;
    /** Registry package name to fetch (differs from linkName only for aliases). */
    name: string;
    /** Version range to resolve against the registry. */
    range: string;
    /** True when the declared value used `npm:` alias syntax. */
    aliased: boolean;
}

/**
 * npm alias syntax: `"<localName>": "npm:<realName>[@<range>]"`. The KEY is a
 * local rename, the VALUE names the real package and its range — so querying the
 * registry for the key asks for a package that either does not exist or (worse)
 * exists at unrelated versions.
 *
 * Returns null for every non-alias value so callers keep `(key, value)` verbatim.
 * The leading `@` of a scoped target is not the version delimiter.
 */
export function parseNpmAliasDep(value: string): { name: string; range: string } | null {
    if (!value.startsWith('npm:')) return null;
    let rest = value.slice(4);
    while (rest.startsWith('/')) rest = rest.slice(1);
    if (!rest) return null;
    // Scoped targets keep their leading '@'; search past it for the version '@'.
    const at = rest.startsWith('@') ? rest.indexOf('@', 1) : rest.indexOf('@');
    const name = at === -1 ? rest : rest.slice(0, at);
    const range = at === -1 ? '' : rest.slice(at + 1);
    // A malformed target must not change behaviour — let the caller fail as before.
    if (!isValidNpmPackageName(name)) return null;
    return { name, range: range || '*' };
}

/** Resolve one `dependencies` entry, honouring `npm:` alias syntax. */
export function npmDepTarget(key: string, value: string): NpmDepTarget {
    const alias = parseNpmAliasDep(value);
    if (!alias) return { linkName: key, name: key, range: value, aliased: false };
    return { linkName: key, name: alias.name, range: alias.range, aliased: true };
}

/** Build a stable cache filename from a URL; ext from path, hash includes query. */
export function cacheFilename(url: string): string {
    try {
        const u = new URL(url);
        const pathname = u.pathname;
        // Query/hash change content identity (CDN ?v=); path alone collides.
        const key = pathname + (u.search || '') + (u.hash || '');
        const dirHash = hashString(key).slice(0, 8);
        const name = extname(pathname) || '.js';
        return `${dirHash}${name}`;
    } catch {
        return hashString(url);
    }
}

/** Verify a Subresource Integrity digest using the strongest supported token. */
export function matchesIntegrity(data: Uint8Array | ArrayBuffer, integrity: string): boolean {
    let strongest = 0;
    let matched = false;
    for (const token of integrity.trim().split(/\s+/)) {
        const separator = token.indexOf('-');
        if (separator <= 0) continue;
        const algorithm = token.slice(0, separator).toLowerCase();
        const strength = algorithm === 'sha512' ? 3 : algorithm === 'sha384' ? 2 : algorithm === 'sha256' ? 1 : 0;
        if (strength === 0 || strength < strongest) continue;
        const expected = token.slice(separator + 1).split('?')[0];
        if (!expected) continue;
        const digest = algorithm === 'sha512'
            ? crypto.sha512(data)
            : algorithm === 'sha384'
                ? crypto.sha384(data)
                : crypto.sha256(data);
        const equal = crypto.base64Encode(digest) === expected;
        if (strength > strongest) {
            strongest = strength;
            matched = equal;
        } else if (equal) {
            matched = true;
        }
    }
    return strongest > 0 && matched;
}

/** True when an SRI string carries at least one supported (sha256+) token. */
export function hasSupportedIntegrity(integrity: string): boolean {
    for (const token of integrity.trim().split(/\s+/)) {
        const separator = token.indexOf('-');
        if (separator <= 0) continue;
        const algorithm = token.slice(0, separator).toLowerCase();
        if (algorithm === 'sha256' || algorithm === 'sha384' || algorithm === 'sha512') return true;
    }
    return false;
}

export const isCacheExpired = (ts: number, ttl: number) => Date.now() - ts > ttl;

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function pad(v: string): [number, number, number, string] {
    const nums: [number, number, number] = [0, 0, 0];
    let part = 0, value = 0, hasDigit = false, i = 0;
    for (; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 48 && c <= 57) {
            value = value * 10 + c - 48;
            hasDigit = true;
            continue;
        }
        if (c === 46) {
            if (part < 3) nums[part] = hasDigit ? value : 0;
            part++;
            value = 0;
            hasDigit = false;
            continue;
        }
        break;
    }
    if (part < 3) nums[part] = hasDigit ? value : 0;
    return [nums[0], nums[1], nums[2], v.charCodeAt(i) === 45 ? v.slice(i + 1) : ''];
}

function coreVersion(v: string): string {
    const [major, minor, patch] = pad(v);
    return `${major}.${minor}.${patch}`;
}

function hasPrerelease(v: string): boolean {
    return pad(v)[3] !== '';
}

function rangeHasPrerelease(range: string): boolean {
    for (let i = 0; i < range.length - 1; i++) {
        if (range.charCodeAt(i) !== 45) continue;
        const c = range.charCodeAt(i + 1);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122)) {
            return true;
        }
    }
    return false;
}

function isDigitCode(c: number): boolean {
    return c >= 48 && c <= 57;
}

function isSemverIdentCode(c: number): boolean {
    return isDigitCode(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 46;
}

function isOneOrTwoPartNumericRange(r: string): boolean {
    let dots = 0, digits = 0, partDigits = 0;
    for (let i = 0; i < r.length; i++) {
        const c = r.charCodeAt(i);
        if (isDigitCode(c)) {
            digits++;
            partDigits++;
            continue;
        }
        if (c !== 46 || dots === 1 || partDigits === 0) return false;
        dots++;
        partDigits = 0;
    }
    return digits > 0 && partDigits > 0;
}

function isExactVersionRange(r: string): boolean {
    let dots = 0, digits = 0, partDigits = 0, prerelease = false;
    for (let i = 0; i < r.length; i++) {
        const c = r.charCodeAt(i);
        if (!prerelease) {
            if (isDigitCode(c)) {
                digits++;
                partDigits++;
                continue;
            }
            if (c === 46 && dots < 2 && partDigits > 0) {
                dots++;
                partDigits = 0;
                continue;
            }
            if (c === 45 && dots === 2 && partDigits > 0 && i + 1 < r.length) {
                prerelease = true;
                continue;
            }
            return false;
        }
        if (!isSemverIdentCode(c)) return false;
    }
    return dots === 2 && digits > 0 && partDigits > 0;
}

function hasWildcardRange(r: string): boolean {
    for (let i = 0; i < r.length; i++) {
        const c = r.charCodeAt(i);
        if (c === 42 || c === 88 || c === 120) return true;
    }
    return false;
}

function comparatorRange(r: string): [string, string] | null {
    const first = r.charCodeAt(0);
    if (first !== 60 && first !== 61 && first !== 62) return null;
    let op = r.charAt(0);
    let start = 1;
    if ((first === 60 || first === 62) && r.charCodeAt(1) === 61) {
        op += '=';
        start = 2;
    }
    while (start < r.length && r.charCodeAt(start) <= 32) start++;
    if (start >= r.length) return null;
    return [op, r.slice(start)];
}

function numericRangeParts(r: string): number {
    let parts = 0;
    let hasDigit = false;
    for (let i = 0; i < r.length; i++) {
        const c = r.charCodeAt(i);
        if (c >= 48 && c <= 57) {
            hasDigit = true;
            continue;
        }
        if (c === 46 && hasDigit) {
            parts++;
            hasDigit = false;
            continue;
        }
        break;
    }
    return parts + (hasDigit ? 1 : 0);
}

function caretUpperBound(r: string): string {
    const [major, minor, patch] = pad(r);
    if (major > 0) return `${major + 1}.0.0`;
    const parts = numericRangeParts(r);
    if (parts < 2) return '1.0.0';
    if (minor > 0 || parts < 3) return `0.${minor + 1}.0`;
    return `0.0.${patch + 1}`;
}

export function compareVersions(a: string, b: string): number {
    const [a0, a1, a2, ap] = pad(a), [b0, b1, b2, bp] = pad(b);
    const d = a0 - b0 || a1 - b1 || a2 - b2;
    if (d) return d;
    if (!ap && !bp) return 0;
    if (!ap) return 1;
    if (!bp) return -1;
    return ap.localeCompare(bp);
}

function satisfies(ver: string, range: string, includePrerelease = rangeHasPrerelease(range)): boolean {
    if (!ver || !range) return false;
    if (hasPrerelease(ver) && !includePrerelease) return false;
    if (range.includes('||')) return satisfiesAnyRange(ver, range);
    const v = coreVersion(ver);
    let r = range.trim();
    if (r.includes(' - ')) {
        const sep = r.indexOf(' - ');
        const lo = r.slice(0, sep);
        const hi = r.slice(sep + 3);
        if (!lo || !hi) return false;
        return compareVersions(ver, lo) >= 0 && compareVersions(ver, hi) <= 0;
    }
    r = compactComparatorSpaces(r);
    if (hasWhitespace(r)) return satisfiesEveryRangePart(ver, r, includePrerelease);
    if (isOneOrTwoPartNumericRange(r)) r += '.x';
    if (isExactVersionRange(r)) return compareVersions(ver, r) === 0;
    if (r.startsWith('^')) {
        const base = r.slice(1);
        return compareVersions(ver, base) >= 0 && compareVersions(ver, caretUpperBound(base)) < 0;
    }
    if (r.startsWith('~')) {
        const base = r.slice(1);
        const [M, m] = pad(base);
        // Major-only (`~1`) bumps the major; with a minor (`~1.2`) bump the minor.
        const upper = numericRangeParts(base) < 2 ? `${M + 1}.0.0` : `${M}.${m + 1}.0`;
        return compareVersions(ver, base) >= 0 && compareVersions(ver, upper) < 0;
    }
    if (hasWildcardRange(r)) {
        return wildcardVersionSatisfies(v, r);
    }
    const comparator = comparatorRange(r);
    if (comparator) {
        const c = compareVersions(ver, comparator[1]);
        return comparator[0] === '>=' ? c >= 0 : comparator[0] === '>' ? c > 0 :
               comparator[0] === '<=' ? c <= 0 : comparator[0] === '<'  ? c < 0 : c === 0;
    }
    return false;
}

function satisfiesAnyRange(ver: string, range: string): boolean {
    let start = 0;
    for (let i = 0; i <= range.length; i++) {
        if (i !== range.length && !(range.charCodeAt(i) === 124 && range.charCodeAt(i + 1) === 124)) continue;
        if (satisfies(ver, range.slice(start, i))) return true;
        start = i + 2;
        i++;
    }
    return false;
}

function compactComparatorSpaces(range: string): string {
    let out = '';
    for (let i = 0; i < range.length; i++) {
        const c = range.charCodeAt(i);
        out += range.charAt(i);
        if (c !== 60 && c !== 61 && c !== 62) continue;
        if (range.charCodeAt(i + 1) === 61) {
            i++;
            out += '=';
        }
        while (range.charCodeAt(i + 1) <= 32 && i + 1 < range.length) i++;
    }
    return out;
}

function hasWhitespace(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) <= 32) return true;
    }
    return false;
}

function satisfiesEveryRangePart(ver: string, range: string, includePrerelease: boolean): boolean {
    let start = 0;
    let sawPart = false;
    for (let i = 0; i <= range.length; i++) {
        if (i !== range.length && range.charCodeAt(i) > 32) continue;
        if (i > start) {
            sawPart = true;
            if (!satisfies(ver, range.slice(start, i), includePrerelease)) return false;
        }
        start = i + 1;
    }
    return sawPart;
}

function wildcardVersionSatisfies(v: string, range: string): boolean {
    const vp = pad(v);
    let start = 0, part = 0;
    for (let i = 0; i <= range.length; i++) {
        if (i !== range.length && range.charCodeAt(i) !== 46) continue;
        const len = i - start;
        if (len === 1) {
            const c = range.charCodeAt(start);
            if (c === 42 || c === 88 || c === 120) {
                start = i + 1;
                part++;
                continue;
            }
        }
        if (String(vp[part]) !== range.slice(start, i).toLowerCase()) return false;
        start = i + 1;
        part++;
    }
    return true;
}

export function matchVersion(vs: string[], r: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < vs.length; i++) {
        const version = vs[i];
        if (version !== undefined && satisfies(version, r)) out.push(version);
    }
    return out;
}
export function latestVersion(vs: string[]): string | null {
    let latestStable: string | null = null;
    let latestPrerelease: string | null = null;
    for (let i = 0; i < vs.length; i++) {
        const version = vs[i];
        if (version === undefined) continue;
        if (hasPrerelease(version)) {
            if (latestPrerelease === null || compareVersions(version, latestPrerelease) > 0) latestPrerelease = version;
        } else if (latestStable === null || compareVersions(version, latestStable) > 0) {
            latestStable = version;
        }
    }
    return latestStable ?? latestPrerelease;
}

export function latestRecordVersion(vs: Record<string, unknown>): string | null {
    let latestStable: string | null = null;
    let latestPrerelease: string | null = null;
    for (const version in vs) {
        if (hasPrerelease(version)) {
            if (latestPrerelease === null || compareVersions(version, latestPrerelease) > 0) latestPrerelease = version;
        } else if (latestStable === null || compareVersions(version, latestStable) > 0) {
            latestStable = version;
        }
    }
    return latestStable ?? latestPrerelease;
}

export const matchLatestVersion = (vs: string[], r: string): string | null => {
    let latest: string | null = null;
    for (let i = 0; i < vs.length; i++) {
        const version = vs[i];
        if (version !== undefined &&
            satisfies(version, r) &&
            (latest === null || compareVersions(version, latest) > 0)) {
            latest = version;
        }
    }
    return latest;
};

export function matchLatestRecordVersion(vs: Record<string, unknown>, r: string): string | null {
    let latest: string | null = null;
    for (const version in vs) {
        if (satisfies(version, r) &&
            (latest === null || compareVersions(version, latest) > 0)) {
            latest = version;
        }
    }
    return latest;
}

// Parse canonical npm:name@version[/sub] (not raw range/alias specs).

export function npmNameVersion(specPath: string): { name: string; version: string } | null {
    if (!specPath.startsWith('npm:')) return null;
    const rest = specPath.slice(4);
    const nameEnd = rest.startsWith('@') ? rest.indexOf('@', 1) : rest.indexOf('@');
    if (nameEnd === -1) return null;
    const name = rest.slice(0, nameEnd);
    const afterName = rest.slice(nameEnd + 1);
    const slash = afterName.indexOf('/');
    const version = slash === -1 ? afterName : afterName.slice(0, slash);
    if (!isValidNpmPackageName(name) || !version || version.includes('\\') || version.includes('\0') ||
        version.includes(':') || /[\u0000-\u0020\u007f]/.test(version)) return null;
    return { name, version };
}

export function npmPackageName(specPath: string): string | null {
    return npmNameVersion(specPath)?.name ?? null;
}

// tar.gz extraction

export interface TarFile {
    path: string;
    content: Uint8Array;
    size: number;
    mode: number;
    type: 'file'|'dir'|'link'|'other';
}

const TAR_ENTRY_TYPES: Record<string, TarFile['type']> = {
    '0': 'file',
    '\0': 'file',
    '5': 'dir',
    '2': 'link',
};

/** ustar prefix (345..500) + name when magic is ustar; name alone is ≤100 bytes. */
function tarHeaderPath(bytes: Uint8Array, pos: number, name: string): string {
    const magic = String.fromCharCode(...bytes.subarray(pos + 257, pos + 263));
    if (magic !== 'ustar\0' && magic !== 'ustar ') return name;
    const prefixSlice = bytes.subarray(pos + 345, pos + 500);
    const n = prefixSlice.indexOf(0);
    const prefix = String.fromCharCode(...(n === -1 ? prefixSlice : prefixSlice.subarray(0, n)));
    if (!prefix) return name;
    return name ? `${prefix}/${name}` : prefix;
}

/** Parse pax `key=value\n` records; only `path` is required for long names. */
function parsePaxPath(content: Uint8Array): string | null {
    let i = 0;
    while (i < content.length) {
        let j = i;
        while (j < content.length && content[j]! >= 0x30 && content[j]! <= 0x39) j++;
        if (j === i || content[j] !== 0x20) break;
        const recLen = parseInt(String.fromCharCode(...content.subarray(i, j)), 10);
        if (!(recLen > 0) || i + recLen > content.length) break;
        const rec = String.fromCharCode(...content.subarray(j + 1, i + recLen));
        const eq = rec.indexOf('=');
        if (eq > 0 && rec.slice(0, eq) === 'path') {
            const v = rec.slice(eq + 1);
            return v.endsWith('\n') ? v.slice(0, -1) : v;
        }
        i += recLen;
    }
    return null;
}

export function unTarGz(data: ArrayBuffer | Uint8Array): TarFile[] {
    const bytes = new Uint8Array(zlib.gunzip(data));
    const str = (off: number, len: number) => {
        // Decode bytes to string, stopping at the first NUL (tar header padding).
        const slice = bytes.subarray(off, off + len);
        const n = slice.indexOf(0);
        const relevant = n === -1 ? slice : slice.subarray(0, n);
        // Bulk convert via spread — safe because tar header fields are ≤ 155 bytes
        return String.fromCharCode(...relevant);
    };
    const oct = (off: number, len: number) => {
        const s = str(off, len).trim();
        return s ? parseInt(s, 8) : 0;
    };
    const zero = (off: number) => {
        for (let i = 0; i < 512; i++) {
            if (bytes[off + i]) return false;
        }
        return true;
    };
    const B = 512, files: TarFile[] = [];
    let pos = 0;
    let nextPath: string | null = null; // GNU 'L' / pax 'x' override for following entry
    while (pos < bytes.length) {
        if (zero(pos) && (pos + B >= bytes.length || zero(pos + B))) break;
        const rawName = str(pos, 100);
        const mode = oct(pos + 100, 8);
        const size = oct(pos + 124, 12);
        const flag = str(pos + 156, 1) || '0';
        if (size < 0) {
            pos += B;
            continue;
        }
        const hdr = pos;
        const start = pos + B;
        const content = bytes.slice(start, start + size);
        pos = start + Math.ceil(size / B) * B;

        // GNU long name / pax path apply to the next real entry only.
        if (flag === 'L') {
            const n = content.indexOf(0);
            nextPath = String.fromCharCode(...(n === -1 ? content : content.subarray(0, n)));
            continue;
        }
        if (flag === 'x' || flag === 'g') {
            if (flag === 'x') {
                const p = parsePaxPath(content);
                if (p) nextPath = p;
            }
            continue;
        }

        const name = nextPath ?? tarHeaderPath(bytes, hdr, rawName);
        nextPath = null;
        if (!name) continue;
        files.push({
            path: name,
            content,
            size,
            mode,
            type: TAR_ENTRY_TYPES[flag] ?? 'other',
        });
    }
    return files;
}

export function stripJsonc(src: string): string {
    let out = '', inStr = false, quote = '', esc = false, block = false, line = false;
    for (let i = 0; i < src.length; i++) {
        const c = src.charAt(i), n = src.charAt(i + 1);
        if (block) {
            if (c === '*' && n === '/') {
                block = false;
                i++;
            }
            continue;
        }
        if (line) {
            if (c === '\n') {
                line = false;
                out += c;
            }
            continue;
        }
        if (inStr) {
            out += c;
            if (esc) {
                esc = false;
            }
            else if (c === '\\') {
                esc = true;
            }
            else if (c === quote) {
                inStr = false;
            }
            continue;
        }
        if (c === '/' && n === '/') {
            line = true;
            i++;
            continue;
        }
        if (c === '/' && n === '*') {
            block = true;
            i++;
            continue;
        }
        if (c === '"' || c === "'") {
            inStr = true;
            quote = c;
        }
        out += c;
    }
    return out;
}

export function safeParse<T = unknown>(json: string): T {
    try {
        const parsed: unknown = JSON.parse(json.trim());
        return parsed as T;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = msg.match(/\(line (\d+) column (\d+)\)/);
        if (m) {
            const line = m[1];
            if (line === undefined) throw err(ErrorKind.SyntaxError, msg);
            const ln = +line;
            const ctx = json.split(/\r?\n/).slice(Math.max(0, ln - 2), ln + 2)
                .map((l, i) => `  ${(i + ln - 1).toString().padStart(4)} | ${l}`).join('\n');
            throw err(ErrorKind.SyntaxError, msg + '\n' + ctx);
        }
        throw err(ErrorKind.SyntaxError, msg);
    }
}

type ArgType = 'string' | 'boolean' | 'number';
type ArgTemplate = Record<string, ArgType>;
type ArgResult<T extends ArgTemplate> = {
    [K in keyof T]?: T[K] extends 'string' ? string : T[K] extends 'number' ? number : boolean;
} & Record<string, string | number | boolean | string[] | undefined> & {
    _?: string;
    _args?: string[];
    _offset: number;
};
export type ParsedArgs = Record<string, string | number | boolean | string[] | undefined> & { _offset: number };

function shouldConsumeArgValue(token: string | undefined, type: ArgType): token is string {
    if (token === undefined || token === '--') return false;
    if (!token.startsWith('-')) return true;
    return type === 'number' && /^-\d+(?:\.\d+)?$/.test(token);
}

export function parseArgs<T extends ArgTemplate>(argv: string[], tpl: T): ArgResult<T> {
    const out: ParsedArgs = { _offset: 0 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === undefined) break;
        if (arg === '--') {
            const positional = argv[i + 1];
            if (positional !== undefined) {
                out._ = positional;
                out._args = argv.slice(i + 2);
                out._offset = i + 2;
            } else {
                out._args = [];
                out._offset = i + 1;
            }
            break;
        }
        if (arg.startsWith('--')) {
            const eqIdx = arg.indexOf('=');
            const key = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2);
            const inlineVal = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;
            const type = tpl[key], next = argv[i + 1];
            if (!type) {
                out[key] = inlineVal ?? true;
                continue;
            }
            if (type === 'boolean') {
                out[key] = inlineVal !== 'false';
            }
            else if (inlineVal !== undefined) {
                out[key] = type === 'number' ? +inlineVal : inlineVal;
            }
            else if (shouldConsumeArgValue(next, type)) {
                out[key] = type === 'number' ? +next : next;
                i++;
            }
        } else if (arg.charAt(0) == '-') {
            for (let j = 1; j < arg.length; j++) {
                const key = arg.charAt(j);
                const type = tpl[key];
                if (!type || type === 'boolean') {
                    out[key] = true;
                    continue;
                }
                const inlineVal = arg.slice(j + 1);
                if (inlineVal) {
                    out[key] = type === 'number' ? +inlineVal : inlineVal;
                } else {
                    const next = argv[i + 1];
                    if (shouldConsumeArgValue(next, type)) {
                        out[key] = type === 'number' ? +next : next;
                        i++;
                    }
                }
                break;
            }
        } else {
            out._ = arg;
            out._args = argv.slice(i + 1);
            out._offset = i + 1;
            break;
        }
    }
    return out as ArgResult<T>;
}
