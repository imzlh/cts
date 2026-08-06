import type { ModuleFormat, FileKind } from '../types';
import { canonicalizePath } from '../utils/path';

const engine = import.meta.use('engine');

// .jspack layout: [4B magic "JSPK"][u16 version][u32 manifestLen][manifest
// JSON][blob table, referenced by offset+length from the manifest].

const MAGIC = [0x4a, 0x53, 0x50, 0x4b]; // "JSPK"
const VERSION = 3;
const HEADER_LEN = 4 + 2 + 4;
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
}

export interface PackManifest {
    /** specPath of the entry module. */
    entry: string;
    /** specPath -> module entry. */
    modules: Record<string, PackModuleEntry>;
    /** parentSpecPath -> (raw import specifier -> child specPath), for
     *  offline resolution of relative/bare imports inside packed code. */
    edges: Record<string, Record<string, string>>;
    /** QuickJS bytecode ABI that produced source-module blobs. */
    bytecodeVersion: string;
}

export interface PackContainer {
    manifest: PackManifest;
    blob: Uint8Array;
}

export function encodePack(manifest: PackManifest, blob: Uint8Array): Uint8Array {
    const header = encodePackHeader(manifest, blob.byteLength);
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

export function encodePackHeader(manifest: PackManifest, blobLength: number): Uint8Array {
    if (!Number.isSafeInteger(blobLength) || blobLength < 0) {
        throw new Error('Cannot encode .jspack file: invalid blob length');
    }
    validateManifest(manifest, blobLength);
    const manifestBytes = engine.encodeString(JSON.stringify(manifest));
    if (manifestBytes.byteLength > MAX_MANIFEST_LEN) {
        throw new Error('Cannot encode .jspack file: manifest is too large');
    }
    const out = new Uint8Array(HEADER_LEN + manifestBytes.byteLength);
    const view = new DataView(out.buffer);
    out.set(MAGIC, 0);
    view.setUint16(4, VERSION, true);
    view.setUint32(6, manifestBytes.byteLength, true);
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
    if (version !== VERSION) throw new Error(`Unsupported .jspack version: ${version}`);
    const manifestLength = view.getUint32(6, true);
    if (manifestLength > MAX_MANIFEST_LEN) throw new Error('Invalid .jspack file: manifest is too large');
    const manifestStart = HEADER_LEN;
    const manifestEnd = manifestStart + manifestLength;
    if (manifestEnd > bytes.byteLength) throw new Error('Invalid .jspack file: truncated manifest');

    const manifestText = engine.decodeString(bytes.subarray(manifestStart, manifestEnd));
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
    const manifest = validateManifest(parsedIds, blob.byteLength);
    return { manifest, blob };
}

export function readBlob(container: PackContainer, entry: PackModuleEntry): Uint8Array {
    // Ranges were validated in decodePack; re-checked because this is public API
    // and subarray would silently clamp a bad range into a truncated module.
    assertRange(container, entry.offset, entry.length, 'blob');
    return container.blob.subarray(entry.offset, entry.offset + entry.length);
}

export function readSourceBlob(container: PackContainer, entry: PackModuleEntry): Uint8Array {
    if (entry.sourceOffset === undefined || entry.sourceLength === undefined) {
        throw new Error('Invalid .jspack file: source module is missing fallback source bytes');
    }
    // Same trust as readBlob — validateManifest already checked source ranges.
    assertRange(container, entry.sourceOffset, entry.sourceLength, 'source');
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

function validateManifest(value: unknown, blobLength: number): PackManifest {
    if (!isRecord(value)) throw new Error('Invalid .jspack file: manifest must be an object');
    const { entry, modules, edges, bytecodeVersion } = value;
    if (typeof entry !== 'string' || !entry.startsWith('pack:') || entry.includes('\0')) {
        throw new Error('Invalid .jspack file: invalid entry module id');
    }
    if (typeof bytecodeVersion !== 'string' || !bytecodeVersion) {
        throw new Error('Invalid .jspack file: missing bytecode version');
    }
    if (!isRecord(modules) || !isRecord(edges)) {
        throw new Error('Invalid .jspack file: modules and edges must be objects');
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
