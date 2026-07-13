/** Post-pack size report: bucket modules and sum unique blob bytes. */

import type { PackManifest } from './format';

export interface PackSizeRow {
    name: string;
    bytes: number;
}

export interface PackSizeSummary {
    /** Sum of unique counted blob ranges (≤ blob table size). */
    total: number;
    /** Largest first; name ascending on ties. */
    rows: PackSizeRow[];
}

function stripQueryHash(path: string): string {
    let end = path.length;
    const q = path.indexOf('?');
    const h = path.indexOf('#');
    if (q >= 0 && q < end) end = q;
    if (h >= 0 && h < end) end = h;
    return end === path.length ? path : path.slice(0, end);
}

/** name@version or @scope/name@version — stop before the package subpath. */
function packageAtVersionKey(path: string): string {
    const p = stripQueryHash(path);
    if (p.startsWith('@')) {
        const scopeEnd = p.indexOf('/');
        if (scopeEnd < 0) return p;
        const after = p.slice(scopeEnd + 1);
        const at = after.indexOf('@');
        if (at < 0) {
            const next = after.indexOf('/');
            return next < 0 ? p : p.slice(0, scopeEnd + 1 + next);
        }
        const slash = after.indexOf('/', at);
        return slash < 0 ? p : p.slice(0, scopeEnd + 1 + slash);
    }
    const at = p.indexOf('@');
    if (at < 0) {
        const slash = p.indexOf('/');
        return slash < 0 ? p : p.slice(0, slash);
    }
    const slash = p.indexOf('/', at);
    return slash < 0 ? p : p.slice(0, slash);
}

/** Host for pack:http(s)/… ids (writer uses pack:https///host/…). */
function remoteAuthorityKey(scheme: string, path: string): string {
    let p = stripQueryHash(path);
    // Collapse the // left over from https:// after stripping the scheme name.
    while (p.startsWith('/')) p = p.slice(1);
    if (!p) return scheme;
    const hostEnd = p.indexOf('/');
    const host = hostEnd < 0 ? p : p.slice(0, hostEnd);
    return host ? `${scheme}://${host}` : scheme;
}

/** Size bucket key: workspace | npm/jsr package | remote host. */
export function sizeBucketForModule(id: string): string {
    // Workspace relocatable ids: pack:/<relative-path>
    if (id.startsWith('pack:/')) return 'workspace';
    if (!id.startsWith('pack:')) return id;

    const rest = id.slice(5);
    const slash = rest.indexOf('/');
    if (slash <= 0) return rest || id;
    const scheme = rest.slice(0, slash);
    const path = rest.slice(slash + 1);

    if (scheme === 'npm') return `npm:${packageAtVersionKey(path)}`;
    if (scheme === 'jsr') return `jsr:${packageAtVersionKey(path)}`;
    if (scheme === 'http' || scheme === 'https') return remoteAuthorityKey(scheme, path);
    if (scheme === 'local') return 'local';
    const head = stripQueryHash(path);
    const headEnd = head.indexOf('/');
    return `${scheme}:${headEnd < 0 ? head : head.slice(0, headEnd)}`;
}

function rangeKey(offset: number, length: number): string {
    return `${offset}\0${length}`;
}

/** Unique blob bytes per bucket (shared ranges counted once, first owner). */
export function summarizePackSizes(manifest: PackManifest): PackSizeSummary {
    const seen = new Set<string>();
    const groups = new Map<string, number>();

    for (const [id, entry] of Object.entries(manifest.modules)) {
        const bucket = sizeBucketForModule(id);
        let add = 0;

        const main = rangeKey(entry.offset, entry.length);
        if (!seen.has(main)) {
            seen.add(main);
            add += entry.length;
        }
        if (entry.sourceOffset !== undefined && entry.sourceLength !== undefined) {
            const src = rangeKey(entry.sourceOffset, entry.sourceLength);
            if (!seen.has(src)) {
                seen.add(src);
                add += entry.sourceLength;
            }
        }
        if (add === 0) continue;
        groups.set(bucket, (groups.get(bucket) ?? 0) + add);
    }

    const rows: PackSizeRow[] = [];
    let total = 0;
    for (const [name, bytes] of groups) {
        rows.push({ name, bytes });
        total += bytes;
    }
    rows.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { total, rows };
}
