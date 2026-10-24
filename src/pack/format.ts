import type { ModuleFormat, FileKind } from '../types';
import { canonicalizePath } from '../utils/path';

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

// .jspack container layout: see cts/docs/pack-format.md
const MAGIC = [0x4a, 0x53, 0x50, 0x4b]; // "JSPK"
const VERSION = 4;
/** Format versions this reader refuses, with the reason, for a usable error. */
const SUPERSEDED_VERSIONS = new Set([1, 2, 3]);
const MANIFEST_DIGEST_LEN = 32; // sha256
const HEADER_LEN = 4 + 2 + 4 + MANIFEST_DIGEST_LEN;
const MAX_MANIFEST_LEN = 64 * 1024 * 1024;
const FORMATS = new Set<ModuleFormat>(['esm', 'cjs']);
const FILE_KINDS = new Set<FileKind>(['source', 'json', 'wasm', 'binary', 'text']);

export interface PackModuleEntry {
    /** Synthetic pack: id, not a host filesystem path. */
    localPath: string;
    format: ModuleFormat;
    fileKind: FileKind;
    offset: number;
    length: number;
    /** Fallback source bytes; mandatory for fileKind "source". */
    sourceOffset?: number;
    sourceLength?: number;
    /** Recompile from bundled source even if bytecode is present. */
    sourceOnly?: boolean;
    /** Explicit source language; set only on source entries. */
    lang?: string;
    /** sha256 of the embedded bytes at offset+length. NOT the on-disk file hash
     *  (sourceMappingURL is stripped first, see ./sourcemap.ts). */
    digest?: string;
    /** sha256 of the embedded bytes at sourceOffset+sourceLength. Source entries only. */
    sourceDigest?: string;
}

function contentDigest(bytes: Uint8Array): string {
    return crypto.hexEncode(crypto.sha256(bytes));
}

function digestEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export interface PackManifest {
    entry: string;
    modules: Record<string, PackModuleEntry>;
    /** parent -> (raw import specifier -> child). */
    edges: Record<string, Record<string, string>>;
    /** QuickJS bytecode ABI. Selects recompile, never verification: the digests
     *  are the integrity mechanism. */
    bytecodeVersion: string;
    /** Declared blob length; without it trailing-data/truncation are undetectable. */
    blobLength?: number;
}

/** Random-access view of blob bytes; the writer streams its blob and never
 *  materializes one buffer. */
export interface PackBlobSource {
    readonly byteLength: number;
    /** Exact bytes at offset+length; must throw if it cannot serve them. */
    range(offset: number, length: number): Uint8Array;
}

export interface PackContainer {
    manifest: PackManifest;
    blob: Uint8Array;
}

export function encodePack(manifest: PackManifest, blob: Uint8Array): Uint8Array {
    const header = encodePackHeader(manifest, blobSourceFromBytes(blob));
    const totalLength = header.byteLength + blob.byteLength;
    if (!Number.isSafeInteger(totalLength)) throw new Error('Cannot encode .jspack file: container is too large');
    let out: Uint8Array;
    try {
        out = new Uint8Array(totalLength);
    } catch (e) {
        throw new Error(`Cannot encode .jspack file: container allocation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    out.set(header, 0);
    out.set(blob, header.byteLength);
    return out;
}

export function blobSourceFromBytes(blob: Uint8Array): PackBlobSource {
    return {
        byteLength: blob.byteLength,
        range(offset: number, length: number): Uint8Array {
            if (!validRange(offset, length, blob.byteLength)) {
                throw new Error(`Cannot encode .jspack file: blob range ${offset}+${length} is out of bounds`);
            }
            return blob.subarray(offset, offset + length);
        },
    };
}

/** Fill in blobLength and per-module digests, returning a copy. A digest already
 *  present is verified, not trusted. */
export function completePackManifest(manifest: PackManifest, source: PackBlobSource): PackManifest {
    const modules: Record<string, PackModuleEntry> = Object.create(null);
    for (const [id, entry] of Object.entries(manifest.modules)) {
        const digest = contentDigest(source.range(entry.offset, entry.length));
        if (entry.digest !== undefined && !digestEqual(entry.digest, digest)) {
            throw new Error(
                `Cannot encode .jspack file: supplied digest for "${id}" does not match its blob bytes ` +
                `(declared ${entry.digest}, actual ${digest})`);
        }
        const out: PackModuleEntry = { ...entry, digest };
        if (entry.fileKind === 'source') {
            // Only reachable on an unvalidated draft; encodePackHeader validates first.
            if (entry.sourceOffset === undefined || entry.sourceLength === undefined) {
                throw new Error(`Cannot encode .jspack file: source module "${id}" is missing its source range`);
            }
            const sourceDigest = contentDigest(source.range(entry.sourceOffset, entry.sourceLength));
            if (entry.sourceDigest !== undefined && !digestEqual(entry.sourceDigest, sourceDigest)) {
                throw new Error(
                    `Cannot encode .jspack file: supplied source digest for "${id}" does not match its blob bytes ` +
                    `(declared ${entry.sourceDigest}, actual ${sourceDigest})`);
            }
            out.sourceDigest = sourceDigest;
        }
        modules[id] = out;
    }
    return { ...manifest, modules, blobLength: source.byteLength };
}

/** Serialize the header and manifest (the bytes preceding the blob). */
export function encodePackHeader(manifest: PackManifest, source: PackBlobSource): Uint8Array {
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
        throw new Error('Cannot encode .jspack file: invalid blob length');
    }
    // Validate before digesting: bounds errors must not surface as digest errors.
    validateManifest(manifest, source.byteLength, false);
    const completed = completePackManifest(manifest, source);
    const manifestBytes = engine.encodeString(JSON.stringify(completed));
    if (manifestBytes.byteLength > MAX_MANIFEST_LEN) {
        throw new Error('Cannot encode .jspack file: manifest is too large');
    }
    const out = new Uint8Array(HEADER_LEN + manifestBytes.byteLength);
    const view = new DataView(out.buffer);
    out.set(MAGIC, 0);
    view.setUint16(4, VERSION, true);
    view.setUint32(6, manifestBytes.byteLength, true);
    out.set(new Uint8Array(crypto.sha256(manifestBytes)), 10);
    out.set(manifestBytes, HEADER_LEN);
    return out;
}

export function decodePack(bytes: Uint8Array): PackContainer {
    if (bytes.byteLength < HEADER_LEN) throw new Error('Invalid .jspack file: too short');
    for (let i = 0; i < MAGIC.length; i++) {
        if (bytes[i] !== MAGIC[i]) throw new Error('Invalid .jspack file: bad magic');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint16(4, true);
    if (version !== VERSION) {
        // Never accept old versions: the attacker-controlled version must not
        // select a weaker verification mode. See cts/docs/pack-format.md.
        throw new Error(SUPERSEDED_VERSIONS.has(version)
            ? `Unsupported .jspack version: ${version}. This file predates pack ` +
              `integrity digests (current version ${VERSION}) and cannot be verified; ` +
              `rebuild it with \`cno pack\`.`
            : `Unsupported .jspack version: ${version}`);
    }
    const manifestLength = view.getUint32(6, true);
    if (manifestLength > MAX_MANIFEST_LEN) throw new Error('Invalid .jspack file: manifest is too large');
    const manifestStart = HEADER_LEN;
    const manifestEnd = manifestStart + manifestLength;
    if (manifestEnd > bytes.byteLength) throw new Error('Invalid .jspack file: truncated manifest');

    // Digest the raw bytes BEFORE parsing; hashing a re-serialization would
    // hide things JSON.parse normalizes away.
    const manifestBytes = bytes.subarray(manifestStart, manifestEnd);
    const declaredDigest = bytesToHex(bytes.subarray(10, 10 + MANIFEST_DIGEST_LEN));
    const actualDigest = contentDigest(manifestBytes);
    if (!digestEqual(declaredDigest, actualDigest)) {
        throw new Error(
            `Invalid .jspack file: manifest digest mismatch (header declares ${declaredDigest}, ` +
            `manifest bytes hash to ${actualDigest}); the container is corrupt or has been modified`);
    }

    const manifestText = engine.decodeString(manifestBytes);
    // The digest cannot catch duplicate keys (it hashes them faithfully).
    assertNoDuplicateKeys(manifestText);
    let parsed: unknown;
    try {
        parsed = JSON.parse(manifestText);
    } catch (e) {
        throw new Error(`Invalid .jspack file: malformed manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
    const blob = bytes.subarray(manifestEnd);
    // Fast path: no backslash in the text means nothing to canonicalize.
    const parsedIds = manifestText.includes('\\') ? canonicalizeIds(parsed) : parsed;
    const manifest = validateManifest(parsedIds, blob.byteLength, true);
    return { manifest, blob };
}

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        const b = bytes[i]!;
        out += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
    }
    return out;
}

/** Scan the JSON string at `start`; null if malformed. Escapes are decoded. */
function scanJsonString(text: string, start: number): { value: string; end: number } | null {
    let out = '';
    let i = start + 1;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === '"') return { value: out, end: i + 1 };
        if (ch !== '\\') { out += ch; i++; continue; }
        const esc = text[i + 1];
        if (esc === undefined) return null;
        if (esc === 'u') {
            const hex = text.slice(i + 2, i + 6);
            if (hex.length < 4) return null;
            let code = 0;
            for (let k = 0; k < 4; k++) {
                const c = hex.charCodeAt(k);
                const d = c >= 48 && c <= 57 ? c - 48
                    : c >= 97 && c <= 102 ? c - 87
                    : c >= 65 && c <= 70 ? c - 55
                    : -1;
                if (d < 0) return null;
                code = code * 16 + d;
            }
            out += String.fromCharCode(code);
            i += 6;
            continue;
        }
        const simple = esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r'
            : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/'
            : esc === '\\' ? '\\' : esc === '"' ? '"' : null;
        if (simple === null) return null;
        out += simple;
        i += 2;
    }
    return null;
}

/** Reject a repeated key inside any one object: JSON.parse keeps only the last,
 *  so the file would run differently than it reads. */
function assertNoDuplicateKeys(text: string): void {
    // null frame = array (no keys); Set frame = object.
    const stack: Array<Set<string> | null> = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === '{') { stack.push(new Set<string>()); i++; continue; }
        if (ch === '[') { stack.push(null); i++; continue; }
        if (ch === '}' || ch === ']') { stack.pop(); i++; continue; }
        if (ch !== '"') { i++; continue; }
        const str = scanJsonString(text, i);
        if (str === null) return; // JSON.parse reports it next
        let j = str.end;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
        if (text[j] === ':') {
            const frame = stack.length > 0 ? stack[stack.length - 1] : undefined;
            if (frame) {
                if (frame.has(str.value)) {
                    throw new Error(
                        `Invalid .jspack file: manifest repeats the key "${str.value}"; ` +
                        `JSON keeps only the last value, so the file would run differently than it reads`);
                }
                frame.add(str.value);
            }
        }
        i = str.end;
    }
}

/** Ranges already digest-checked, per container (keys are shared between
 *  containers that reuse an entry object). */
const verifiedRanges = new WeakMap<PackContainer, Set<string>>();

/** Verify an embedded range against its manifest digest, once per container.
 *  A missing digest is a hard failure, never a skip. */
function verifyRange(
    container: PackContainer,
    id: string,
    offset: number,
    length: number,
    declared: string | undefined,
    what: string,
): void {
    if (declared === undefined) {
        throw new Error(`Invalid .jspack file: module "${id}" has no ${what} digest to verify against`);
    }
    let seen = verifiedRanges.get(container);
    if (seen === undefined) {
        seen = new Set<string>();
        verifiedRanges.set(container, seen);
    }
    const key = `${what}\0${offset}\0${length}\0${declared}`;
    if (seen.has(key)) return;
    const actual = contentDigest(container.blob.subarray(offset, offset + length));
    if (!digestEqual(declared, actual)) {
        throw new Error(
            `Invalid .jspack file: ${what} digest mismatch for "${id}" ` +
            `(manifest declares ${declared}, blob bytes at ${offset}+${length} hash to ${actual}); ` +
            `the container is corrupt or has been modified`);
    }
    seen.add(key);
}

export function readBlob(container: PackContainer, entry: PackModuleEntry): Uint8Array {
    // subarray clamps, so a bad range would look like a short valid module.
    assertRange(container, entry.offset, entry.length, 'blob');
    verifyRange(container, entry.localPath, entry.offset, entry.length, entry.digest, 'blob');
    return container.blob.subarray(entry.offset, entry.offset + entry.length);
}

export function readSourceBlob(container: PackContainer, entry: PackModuleEntry): Uint8Array {
    if (entry.sourceOffset === undefined || entry.sourceLength === undefined) {
        throw new Error('Invalid .jspack file: source module is missing fallback source bytes');
    }
    assertRange(container, entry.sourceOffset, entry.sourceLength, 'source');
    verifyRange(container, entry.localPath, entry.sourceOffset, entry.sourceLength, entry.sourceDigest, 'source');
    return container.blob.subarray(entry.sourceOffset, entry.sourceOffset + entry.sourceLength);
}

/** subarray clamps, so an unchecked out-of-range entry would look valid. */
function assertRange(container: PackContainer, offset: number, length: number, what: string): void {
    if (!validRange(offset, length, container.blob.byteLength)) {
        throw new Error(`Invalid .jspack file: ${what} range ${offset}+${length} is out of bounds`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Canonicalize module/edge-parent ids ('\' -> '/') before validation, because
 *  the resolver looks ids up in canonical form and '\' ids would be unreachable.
 *  Edge specifier keys are raw import strings and stay verbatim. */
function canonicalizeIds(value: unknown): unknown {
    if (!isRecord(value)) return value;
    const { entry, modules, edges } = value;
    if (!isRecord(modules) || !isRecord(edges)) return value;

    const outModules: Record<string, unknown> = Object.create(null);
    for (const [id, raw] of Object.entries(modules)) {
        const key = canonicalizePath(id);
        if (Object.prototype.hasOwnProperty.call(outModules, key)) {
            throw new Error(`Invalid .jspack file: duplicate module id "${key}" after path canonicalization`);
        }
        outModules[key] = isRecord(raw) && typeof raw.localPath === 'string'
            ? { ...raw, localPath: canonicalizePath(raw.localPath) }
            : raw;
    }

    const outEdges: Record<string, unknown> = Object.create(null);
    for (const [parent, bucket] of Object.entries(edges)) {
        const key = canonicalizePath(parent);
        if (Object.prototype.hasOwnProperty.call(outEdges, key)) {
            throw new Error(`Invalid .jspack file: duplicate edge parent "${key}" after path canonicalization`);
        }
        if (!isRecord(bucket)) {
            outEdges[key] = bucket;
            continue;
        }
        const outBucket: Record<string, unknown> = Object.create(null);
        for (const [specifier, target] of Object.entries(bucket)) {
            outBucket[specifier] = typeof target === 'string' ? canonicalizePath(target) : target;
        }
        outEdges[key] = outBucket;
    }

    return {
        ...value,
        entry: typeof entry === 'string' ? canonicalizePath(entry) : entry,
        modules: outModules,
        edges: outEdges,
    };
}

function validRange(offset: unknown, length: unknown, blobLength: number): offset is number {
    return Number.isSafeInteger(offset) && Number.isSafeInteger(length)
        && Number(offset) >= 0 && Number(length) >= 0
        && Number(offset) <= blobLength - Number(length);
}

interface BlobSpan { start: number; end: number; id: string; what: string }

function spanKey(start: number, end: number): string {
    return `${start}\0${end}`;
}

/** Ranges must be identical (dedup) or disjoint; source bytecode must be unique
 *  and never alias other bytecode or source. Aliasing would run foreign code
 *  under a clean id; bytecode is not self-describing enough to catch it later.
 *  Zero-length ranges are ignored. */
function validateBlobLayout(modules: Record<string, unknown>): void {
    const spans: BlobSpan[] = [];
    const bytecodeOwner = new Map<string, string>();
    const sourceSpans = new Set<string>();

    for (const [id, raw] of Object.entries(modules)) {
        if (!isRecord(raw)) continue;
        const offset = raw.offset as number;
        const length = raw.length as number;
        const isSource = raw.fileKind === 'source';
        if (length > 0) {
            const key = spanKey(offset, offset + length);
            spans.push({ start: offset, end: offset + length, id, what: isSource ? 'bytecode' : 'payload' });
            if (isSource) {
                const previous = bytecodeOwner.get(key);
                if (previous !== undefined) {
                    throw new Error(
                        `Invalid .jspack file: modules "${previous}" and "${id}" declare the same bytecode ` +
                        `range ${offset}+${length}; a module's bytecode is compiled under its own id and is never shared`);
                }
                bytecodeOwner.set(key, id);
            }
        }
        if (isSource) {
            const sourceOffset = raw.sourceOffset as number;
            const sourceLength = raw.sourceLength as number;
            if (sourceLength > 0) {
                const key = spanKey(sourceOffset, sourceOffset + sourceLength);
                sourceSpans.add(key);
                spans.push({ start: sourceOffset, end: sourceOffset + sourceLength, id, what: 'source' });
            }
        }
    }

    for (const [key, id] of bytecodeOwner) {
        if (sourceSpans.has(key)) {
            const sep = key.indexOf('\0');
            throw new Error(
                `Invalid .jspack file: module "${id}" points its bytecode at embedded source bytes ` +
                `(${key.slice(0, sep)}..${key.slice(sep + 1)}); bytecode and source are separate blob entries`);
        }
    }

    const distinct = new Map<string, BlobSpan>();
    for (const span of spans) {
        const key = spanKey(span.start, span.end);
        if (!distinct.has(key)) distinct.set(key, span);
    }
    const sorted = [...distinct.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    let coveredTo = 0;
    let coveredBy: BlobSpan | null = null;
    for (const span of sorted) {
        if (coveredBy !== null && span.start < coveredTo) {
            throw new Error(
                `Invalid .jspack file: ${span.what} range ${span.start}+${span.end - span.start} of "${span.id}" ` +
                `overlaps ${coveredBy.what} range ${coveredBy.start}+${coveredBy.end - coveredBy.start} of ` +
                `"${coveredBy.id}"; blob entries must be disjoint or identical`);
        }
        if (span.end > coveredTo) {
            coveredTo = span.end;
            coveredBy = span;
        }
    }
}

const HEX_DIGEST_LEN = MANIFEST_DIGEST_LEN * 2;

/** Lowercase hex of exactly sha256 width. */
function isHexDigest(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== HEX_DIGEST_LEN) return false;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        const ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102); // 0-9 a-f
        if (!ok) return false;
    }
    return true;
}

/** @param requireDigests false only inside encodePackHeader, before digests exist. */
function validateManifest(value: unknown, blobLength: number, requireDigests: boolean): PackManifest {
    if (!isRecord(value)) throw new Error('Invalid .jspack file: manifest must be an object');
    const { entry, modules, edges, bytecodeVersion, blobLength: declaredBlobLength } = value;
    if (typeof entry !== 'string' || !entry.startsWith('pack:') || entry.includes('\0')) {
        throw new Error('Invalid .jspack file: invalid entry module id');
    }
    if (typeof bytecodeVersion !== 'string' || !bytecodeVersion) {
        throw new Error('Invalid .jspack file: missing bytecode version');
    }
    if (!isRecord(modules) || !isRecord(edges)) {
        throw new Error('Invalid .jspack file: modules and edges must be objects');
    }
    // Catches truncation and trailing data that per-range checks cannot see.
    if (requireDigests || declaredBlobLength !== undefined) {
        if (!Number.isSafeInteger(declaredBlobLength) || Number(declaredBlobLength) < 0) {
            throw new Error('Invalid .jspack file: missing or invalid blob length');
        }
        if (declaredBlobLength !== blobLength) {
            throw new Error(
                `Invalid .jspack file: blob length mismatch (manifest declares ${declaredBlobLength}, ` +
                `container carries ${blobLength}); the file is truncated or has trailing data`);
        }
    }

    for (const [id, raw] of Object.entries(modules)) {
        if (!id.startsWith('pack:') || id.includes('\0') || !isRecord(raw)) {
            throw new Error(`Invalid .jspack file: invalid module entry "${id}"`);
        }
        if (raw.localPath !== id || !FORMATS.has(raw.format as ModuleFormat) || !FILE_KINDS.has(raw.fileKind as FileKind)) {
            throw new Error(`Invalid .jspack file: invalid module metadata for "${id}"`);
        }
        if (!validRange(raw.offset, raw.length, blobLength)) {
            throw new Error(`Invalid .jspack file: blob range is out of bounds for "${id}"`);
        }
        if (raw.fileKind === 'source') {
            // Mandatory, not just bounds-checked: validRange passes on undefined.
            if (raw.sourceOffset === undefined || raw.sourceLength === undefined) {
                throw new Error(`Invalid .jspack file: source module "${id}" is missing its source range`);
            }
            if (!validRange(raw.sourceOffset, raw.sourceLength, blobLength)) {
                throw new Error(`Invalid .jspack file: source range is out of bounds for "${id}"`);
            }
        }
        if (raw.fileKind !== 'source' &&
            (raw.sourceOffset !== undefined || raw.sourceLength !== undefined || raw.sourceOnly !== undefined || raw.lang !== undefined)) {
            throw new Error(`Invalid .jspack file: non-source module has source metadata for "${id}"`);
        }
        if (raw.fileKind !== 'source' && raw.sourceDigest !== undefined) {
            throw new Error(`Invalid .jspack file: non-source module has a source digest for "${id}"`);
        }
        if (raw.digest !== undefined && !isHexDigest(raw.digest)) {
            throw new Error(`Invalid .jspack file: invalid blob digest for "${id}"`);
        }
        if (raw.sourceDigest !== undefined && !isHexDigest(raw.sourceDigest)) {
            throw new Error(`Invalid .jspack file: invalid source digest for "${id}"`);
        }
        if (requireDigests) {
            if (raw.digest === undefined) {
                throw new Error(`Invalid .jspack file: module "${id}" is missing its blob digest`);
            }
            if (raw.fileKind === 'source' && raw.sourceDigest === undefined) {
                throw new Error(`Invalid .jspack file: source module "${id}" is missing its source digest`);
            }
        }
        if (raw.sourceOnly !== undefined && typeof raw.sourceOnly !== 'boolean') {
            throw new Error(`Invalid .jspack file: invalid sourceOnly flag for "${id}"`);
        }
        if (raw.sourceOnly === true && raw.fileKind !== 'source') {
            throw new Error(`Invalid .jspack file: sourceOnly requires fileKind source for "${id}"`);
        }
        if (raw.lang !== undefined && (typeof raw.lang !== 'string' || !raw.lang)) {
            throw new Error(`Invalid .jspack file: invalid source language for "${id}"`);
        }
    }
    if (!Object.prototype.hasOwnProperty.call(modules, entry)) {
        throw new Error(`Invalid .jspack file: entry module "${entry}" is missing`);
    }
    validateBlobLayout(modules);

    for (const [parent, rawBucket] of Object.entries(edges)) {
        if (!Object.prototype.hasOwnProperty.call(modules, parent) || !isRecord(rawBucket)) {
            throw new Error(`Invalid .jspack file: invalid edge parent "${parent}"`);
        }
        for (const [specifier, target] of Object.entries(rawBucket)) {
            if (!specifier || specifier.includes('\0') || typeof target !== 'string' ||
                !Object.prototype.hasOwnProperty.call(modules, target)) {
                throw new Error(`Invalid .jspack file: invalid edge from "${parent}"`);
            }
        }
    }

    return value as unknown as PackManifest;
}
