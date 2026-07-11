import type { ModuleFormat, FileKind } from '../types';

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
    /** Synthetic runtime id, directory-structure-preserving: "pack:/<rel>" for
     *  workspace files, "pack:<scheme>/<rest>" for external modules — see
     *  writer.ts. Doubles as the human-readable display path. The reader
     *  rewrites entries to safe materialized paths — see reader.ts. */
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
    const manifest = validateManifest(parsed, blob.byteLength);
    return { manifest, blob };
}

export function readBlob(container: PackContainer, entry: PackModuleEntry): Uint8Array {
    return checkedBlobSlice(container.blob, entry.offset, entry.length);
}

export function readSourceBlob(container: PackContainer, entry: PackModuleEntry): Uint8Array {
    if (entry.sourceOffset === undefined || entry.sourceLength === undefined) {
        throw new Error('Invalid .jspack file: source module is missing fallback source bytes');
    }
    return checkedBlobSlice(container.blob, entry.sourceOffset, entry.sourceLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRange(offset: unknown, length: unknown, blobLength: number): offset is number {
    return Number.isSafeInteger(offset) && Number.isSafeInteger(length)
        && Number(offset) >= 0 && Number(length) >= 0
        && Number(offset) <= blobLength - Number(length);
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
        if (raw.sourceOnly !== undefined && typeof raw.sourceOnly !== 'boolean') {
            throw new Error(`Invalid .jspack file: invalid sourceOnly flag for "${id}"`);
        }
        if (raw.lang !== undefined && (typeof raw.lang !== 'string' || !raw.lang)) {
            throw new Error(`Invalid .jspack file: invalid source language for "${id}"`);
        }
    }
    if (!Object.prototype.hasOwnProperty.call(modules, entry)) {
        throw new Error(`Invalid .jspack file: entry module "${entry}" is missing`);
    }

    for (const [parent, rawBucket] of Object.entries(edges)) {
        if (!Object.prototype.hasOwnProperty.call(modules, parent) || !isRecord(rawBucket)) {
            throw new Error(`Invalid .jspack file: invalid edge parent "${parent}"`);
        }
        for (const [specifier, target] of Object.entries(rawBucket)) {
            if (!specifier || typeof target !== 'string' || !Object.prototype.hasOwnProperty.call(modules, target)) {
                throw new Error(`Invalid .jspack file: invalid edge from "${parent}"`);
            }
        }
    }

    return value as unknown as PackManifest;
}

function checkedBlobSlice(blob: Uint8Array, offset: number, length: number): Uint8Array {
    if (!validRange(offset, length, blob.byteLength)) {
        throw new Error('Invalid .jspack file: blob range is out of bounds');
    }
    return blob.subarray(offset, offset + length);
}
