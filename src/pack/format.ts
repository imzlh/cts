import type { ModuleFormat, FileKind } from '../types';
import { canonicalizePath } from '../utils/path';

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

// .jspack layout: [4B magic "JSPK"][u16 version][u32 manifestLen]
// [32B manifestDigest][manifest JSON][blob table, referenced by offset+length
// from the manifest].
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
    /** Synthetic runtime id ("pack:/<rel>" or "pack:<scheme>/…"). Also the
     *  PackBlobStore / loader key after install — not a host filesystem path. */
    localPath: string;
    format: ModuleFormat;
    fileKind: FileKind;
    offset: number;
    length: number;
    /** Original source bytes used when bytecode was produced by another QuickJS ABI. */
    sourceOffset?: number;
    sourceLength?: number;
    /** Compile from bundled source because serialized bytecode loses required semantics. */
    sourceOnly?: boolean;
    /** Explicit source language for entries whose path has no useful extension. */
    lang?: string;
    /** Lowercase-hex sha256 of the EMBEDDED bytes at offset+length — the
     *  bytecode for a source module, the payload otherwise. Verified lazily by
     *  readBlob. Not the digest of the file on disk: a source module's embedded
     *  bytes have had sourceMappingURL stripped (see ./sourcemap.ts), so the two
     *  differ for any module that carried an annotation. */
    digest?: string;
    /** Lowercase-hex sha256 of the embedded bytes at sourceOffset+sourceLength.
     *  Source modules only. Verified lazily by readSourceBlob. */
    sourceDigest?: string;
}

/** Lowercase-hex sha256, the manifest's digest encoding. */
function contentDigest(bytes: Uint8Array): string {
    return crypto.hexEncode(crypto.sha256(bytes));
}

/** Constant-time-ish hex compare. These digests are not secrets and an attacker
 *  who can time this can also just recompute them, so this is only about not
 *  short-circuiting on the first nibble; correctness is what matters here. */
function digestEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export interface PackManifest {
    /** specPath of the entry module. */
    entry: string;
    /** specPath -> module entry. */
    modules: Record<string, PackModuleEntry>;
    /** parentSpecPath -> (raw import specifier -> child specPath), for
     *  offline resolution of relative/bare imports inside packed code. */
    edges: Record<string, Record<string, string>>;
    /** QuickJS bytecode ABI that produced source-module blobs.
     *
     *  NOT a security control. It selects bytecode-vs-recompile and nothing
     *  else; it is attacker-controlled like every other manifest field, and a
     *  tamperer sets it *correctly* so their bytecode runs instead of being
     *  recompiled from source. The digests are the integrity mechanism. */
    bytecodeVersion: string;
    /** Declared blob byte length. Present so truncation and tail-extension are
     *  caught eagerly instead of only when they happen to cut a declared range:
     *  the blob is "whatever bytes remain after the manifest", so without this
     *  its length is implicit and uncheckable. Covered by manifestDigest. */
    blobLength?: number;
}

/** Random-access view of blob bytes for digest computation at encode time.
 *  The writer streams its blob chunk-by-chunk and never materializes it as one
 *  buffer, so it supplies its BlobBuilder here rather than a flat array. */
export interface PackBlobSource {
    readonly byteLength: number;
    /** Exact bytes at offset+length. Must throw if the range is not one the
     *  source can serve exactly. */
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

/** Adapt a materialized blob to PackBlobSource. */
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

/** Fill in blobLength and the per-module digests, returning a COPY.
 *
 *  Exported so the writer can record in its returned manifest exactly what it
 *  put on disk. Calling it twice is safe and cheap to reason about: the second
 *  call recomputes every digest and compares, which is a genuine self-check that
 *  the blob source and the manifest ranges agree.
 *
 *  Digests are computed here, from the bytes actually being embedded, rather
 *  than accepted from the caller. That is deliberate and it is the whole reason
 *  this function exists: the writer separately keeps a digest of each source
 *  file's ON-DISK bytes for its "source changed while packing" check, and those
 *  two digests differ for every module whose sourceMappingURL was stripped on
 *  the way into the blob. Computing from the embedded bytes at the one place
 *  that has them makes it impossible to wire the wrong one in.
 *
 *  A digest already present on an entry is verified, not trusted, so a
 *  hand-built manifest carrying a stale digest fails at write time. */
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
            const sourceDigest = contentDigest(source.range(entry.sourceOffset!, entry.sourceLength!));
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

/** Serialize header + manifest. Returns the bytes that precede the blob.
 *
 *  Takes a PackBlobSource rather than a length because the per-module digests
 *  are computed here; the streamed writer hands over its in-memory chunk list.
 *  The manifest digest necessarily covers the manifest bytes as serialized here,
 *  which is why it sits in the fixed-width header, outside its own coverage. */
export function encodePackHeader(manifest: PackManifest, source: PackBlobSource): Uint8Array {
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) {
        throw new Error('Cannot encode .jspack file: invalid blob length');
    }
    // Shape and bounds first: completeManifest reads every declared range, and
    // an out-of-bounds one should report as a range error, not a digest error.
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
        // A digest-less container is UNVERIFIABLE, so accepting one — even with a
        // warning — would hand the attacker the bypass: flip this byte back to 3,
        // drop the digest field, and every check below is skipped. The version is
        // attacker-controlled, so it must not select the verification mode. Same
        // shape as JWT "alg":"none". .jspack files are regenerable build
        // artifacts, so the cost of refusing is one `cno pack`.
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

    // Verify the root digest BEFORE parsing, for two reasons: a malformed or
    // hostile manifest never reaches JSON.parse, and the digest covers the raw
    // bytes as they sit in the file. Hashing a re-serialization of the parsed
    // object instead would silently drop anything JSON.parse normalizes away —
    // duplicate keys collapse to the last occurrence, so a manifest that reads
    // one way and runs another would hash as if it were clean.
    const manifestBytes = bytes.subarray(manifestStart, manifestEnd);
    const declaredDigest = bytesToHex(bytes.subarray(10, 10 + MANIFEST_DIGEST_LEN));
    const actualDigest = contentDigest(manifestBytes);
    if (!digestEqual(declaredDigest, actualDigest)) {
        throw new Error(
            `Invalid .jspack file: manifest digest mismatch (header declares ${declaredDigest}, ` +
            `manifest bytes hash to ${actualDigest}); the container is corrupt or has been modified`);
    }

    const manifestText = engine.decodeString(manifestBytes);
    // Reject duplicate top-level module/edge keys before parsing hides them.
    // JSON.parse collapses duplicates to the LAST occurrence per ECMA-262, so a
    // manifest can read one way to a human auditing the artifact and run
    // another. The digest does not help here: it covers these exact bytes, so a
    // duplicate is faithfully hashed and passes. Cheap to reject outright.
    assertNoDuplicateKeys(manifestText);
    let parsed: unknown;
    try {
        parsed = JSON.parse(manifestText);
    } catch (e) {
        throw new Error(`Invalid .jspack file: malformed manifest: ${e instanceof Error ? e.message : String(e)}`);
    }
    const blob = bytes.subarray(manifestEnd);
    // Fast path: JSON escapes '\' as '\\', so a manifest whose text contains no
    // backslash at all cannot carry a separator to canonicalize. Skip the
    // manifest rebuild on every startup (decodeMs is on the startup path).
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

/** Per-container record of which ranges have already been digest-checked, so a
 *  repeatedly-read module is hashed once. Keyed by container so two containers
 *  sharing an entry object (a test cloning a manifest) cannot cross-credit. */
/** Read the JSON string starting at `start` (which must be '"'), returning its
 *  decoded value and the index just past the closing quote, or null if it is
 *  malformed. Escapes are decoded so two spellings of one key ("a" and
 *  "a") compare equal, which is how JSON.parse would see them. */
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

/** Reject a manifest whose text repeats a key inside any one object.
 *
 *  Not redundant with the digest: the digest covers these exact bytes, so a
 *  duplicate hashes faithfully and passes. What it defeats is *review* — a
 *  reader sees the first value, the runtime uses the last. One linear scan, same
 *  order as the JSON.parse that follows. */
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
        // Malformed: leave the diagnostic to JSON.parse, which runs next.
        if (str === null) return;
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

const verifiedRanges = new WeakMap<PackContainer, Set<string>>();

/** Verify an embedded range against its manifest digest, once per container.
 *
 *  Lazy on purpose: this runs on the startup path and hashing the whole blob
 *  eagerly would make every launch pay for modules it never loads. The bytes
 *  hashed here are bytes the caller is about to read anyway.
 *
 *  A missing digest is a hard failure, not a skip. decodePack requires the field
 *  on every entry, so absence means the manifest was built by something other
 *  than encodePackHeader — and "no digest means don't check" is exactly the
 *  bypass this whole mechanism exists to remove. */
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
    // Ranges were validated in decodePack; re-checked because this is public API
    // and subarray would silently clamp a bad range into a truncated module.
    assertRange(container, entry.offset, entry.length, 'blob');
    verifyRange(container, entry.localPath, entry.offset, entry.length, entry.digest, 'blob');
    return container.blob.subarray(entry.offset, entry.offset + entry.length);
}

export function readSourceBlob(container: PackContainer, entry: PackModuleEntry): Uint8Array {
    if (entry.sourceOffset === undefined || entry.sourceLength === undefined) {
        throw new Error('Invalid .jspack file: source module is missing fallback source bytes');
    }
    // Same trust as readBlob — validateManifest already checked source ranges.
    assertRange(container, entry.sourceOffset, entry.sourceLength, 'source');
    verifyRange(container, entry.localPath, entry.sourceOffset, entry.sourceLength, entry.sourceDigest, 'source');
    return container.blob.subarray(entry.sourceOffset, entry.sourceOffset + entry.sourceLength);
}

/** Guard against silent truncation: subarray clamps, so an out-of-range entry
 *  would otherwise yield a short buffer that looks like a valid module. */
function assertRange(container: PackContainer, offset: number, length: number, what: string): void {
    if (!validRange(offset, length, container.blob.byteLength)) {
        throw new Error(`Invalid .jspack file: ${what} range ${offset}+${length} is out of bounds`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rewrite container ids into the canonical separator form before validation.
 *
 *  Module ids are opaque keys — never filesystem paths — but ModuleResolver
 *  canonicalizes every specifier (canonicalizePath: '\' -> '/') before it looks
 *  a pack id up in this manifest. A container carrying '\' in an id (produced on
 *  Windows, or hand-crafted) would therefore be silently unreachable: the entry
 *  lookup misses and the loader blames static analysis with ModuleNotFound.
 *  Canonicalizing here keeps reader keys and resolver lookups in one form, and
 *  makes a container behave identically on Windows and POSIX.
 *
 *  Edge *specifier* keys are left verbatim: they are raw import strings, not
 *  ids, and a non-matching one already fails closed with a message naming it.
 *  encodePack stays a faithful serializer so callers can build exact fixtures. */
function canonicalizeIds(value: unknown): unknown {
    if (!isRecord(value)) return value;
    const { entry, modules, edges } = value;
    // Shape errors belong to validateManifest, which runs on the result.
    if (!isRecord(modules) || !isRecord(edges)) return value;

    const outModules: Record<string, unknown> = Object.create(null);
    for (const [id, raw] of Object.entries(modules)) {
        const key = canonicalizePath(id);
        if (Object.prototype.hasOwnProperty.call(outModules, key)) {
            throw new Error(`Invalid .jspack file: duplicate module id "${key}" after path canonicalization`);
        }
        // localPath mirrors the id (validateManifest enforces it) — keep in step.
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

/** Reject blob layouts no writer can produce, because they let a container run
 *  code its own manifest and embedded source disown.
 *
 *  BlobBuilder only ever *appends whole buffers*, and dedupes by local path, so
 *  every declared range is either byte-identical to another (a deduped source or
 *  asset payload — legitimate: two ids may share one file, e.g. `a.ts` and
 *  `a.ts?v=1`) or completely disjoint. Nothing partially overlaps or nests.
 *
 *  A source module's *bytecode* is stricter still: it is a fresh append per
 *  module id, compiled under that id (the id is baked into the bytecode atom
 *  table as the eval filename), so it can never alias another module's bytecode
 *  or any module's embedded source. Aliasing it is the interesting attack: point
 *  `pack:/safe.ts`'s bytecode range at `pack:/evil.ts`'s bytecode and the
 *  runtime executes evil's body, and exports its bindings, under safe's id —
 *  exit 0, no diagnostic, while safe's untouched source still sits in the blob
 *  for anyone auditing the artifact. Bytecode is not self-describing enough for
 *  the loader to notice, so the layout invariant is enforced here instead.
 *
 *  Zero-length ranges are ignored: they address no bytes, so they cannot alias
 *  a payload, and an empty source file is a legitimate 0-byte range. */
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

    // Identical spans are legitimate dedup, so compare only distinct ones: after
    // dedup any remaining intersection is a partial overlap or a nesting, and
    // neither can come out of an append-only builder.
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

/** Lowercase hex of exactly sha256 width. Rejected early so a mismatch is
 *  reported as a malformed manifest rather than as a digest mismatch. */
function isHexDigest(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== HEX_DIGEST_LEN) return false;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        const ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102); // 0-9 a-f
        if (!ok) return false;
    }
    return true;
}

/** @param requireDigests decode-side strictness. False only inside
 *  encodePackHeader, which runs before completeManifest has filled the digests
 *  in; every container that reaches a reader must carry them. */
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
    // The blob is "whatever bytes follow the manifest", so its length is only
    // checkable against a declaration. This catches truncation that stops short
    // of any declared range, and tail-extension, neither of which any per-range
    // bounds check can see. Safe to trust because manifestDigest covers it.
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
        if (raw.fileKind === 'source' && !validRange(raw.sourceOffset, raw.sourceLength, blobLength)) {
            throw new Error(`Invalid .jspack file: source range is out of bounds for "${id}"`);
        }
        if (raw.fileKind !== 'source' &&
            (raw.sourceOffset !== undefined || raw.sourceLength !== undefined || raw.sourceOnly !== undefined || raw.lang !== undefined)) {
            throw new Error(`Invalid .jspack file: non-source module has source metadata for "${id}"`);
        }
        // A non-source module has no source range, so a sourceDigest on one
        // would name bytes that do not exist — reject rather than ignore.
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
        // sourceOnly means "must recompile from fallback source" — the source
        // range is mandatory (already checked for fileKind===source above).
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
    // Ranges are individually in bounds by here; check how they relate.
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
