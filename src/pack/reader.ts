import type { ModuleResolver } from '../resolve/index';
import type { JscCache } from '../source/cache';
import { PackHandler } from '../resolve/protocols/pack';
import { decodePack, readBlob, readSourceBlob, type PackManifest } from './format';
import { ensureDir, joinPaths, dirname, basename } from '../utils';

const fs = import.meta.use('fs');
const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
let extractTempId = 0;

export interface LoadedPack {
    manifest: PackManifest;
}

// Loads a .jspack container: validates it, materializes bundled source/assets
// to safe generated paths (content-checked), pre-seeds bytecode, registers pack:.
export function loadPack(
    jspackPath: string,
    resolver: ModuleResolver,
    jsc: JscCache,
    cacheDir: string,
): LoadedPack {
    const bytes = new Uint8Array(fs.readFile(jspackPath));
    const container = decodePack(bytes);
    const manifest = container.manifest;

    const hash = crypto.hexEncode(crypto.sha256(bytes));
    const extractDir = joinPaths(cacheDir, 'pack-extract', hash);
    const completeMarker = joinPaths(extractDir, '.complete');

    // Always verify each file's bytes. .complete only means "a prior extract
    // finished"; size alone cannot catch same-length tampering.
    let index = 0;
    for (const specPath of Object.keys(manifest.modules)) {
        const entry = manifest.modules[specPath];
        if (!entry) continue;
        const raw = entry.fileKind === 'source' ? readSourceBlob(container, entry) : readBlob(container, entry);
        const realPath = joinPaths(extractDir, safeModuleName(specPath, index++));
        if (!hasExpectedContent(realPath, raw)) writeExtractedFile(realPath, raw);
        if (entry.fileKind === 'source') {
            if (!entry.sourceOnly && manifest.bytecodeVersion === engine.versions.quickjs) {
                jsc.setMemory(realPath, readBlob(container, entry).slice().buffer);
            }
        }
        entry.localPath = realPath;
    }

    if (!fs.exists(completeMarker)) {
        ensureDir(extractDir);
        writeExtractedFile(completeMarker, new Uint8Array());
    }

    resolver.registerPackHandler(new PackHandler(manifest));
    return { manifest };
}

function hasExpectedContent(path: string, expected: Uint8Array): boolean {
    try {
        if (fs.stat(path).size !== expected.byteLength) return false;
        const actual = new Uint8Array(fs.readFile(path));
        for (let i = 0; i < expected.byteLength; i++) {
            if (actual[i] !== expected[i]) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function writeExtractedFile(path: string, bytes: Uint8Array): void {
    ensureDir(dirname(path));
    const pid = typeof os.pid === 'number' || typeof os.pid === 'string' ? String(os.pid) : 'runtime';
    const tempPath = `${path}.tmp-${pid}-${Date.now()}-${extractTempId++}`;
    let fd: number | null = null;
    try {
        fd = fs.open(tempPath, 'wx', 0o600);
        writeAll(fd, bytes);
        fs.fsync(fd);
        fs.close(fd);
        fd = null;
        replaceExtractedFile(tempPath, path, bytes);
    } finally {
        if (fd !== null) {
            try { fs.close(fd); } catch {}
        }
        try { fs.unlink(tempPath); } catch {}
    }
}

// Linux rename replaces; Windows fails if the destination exists. On conflict
// another process may already have healthy bytes — only unlink+retry when not.
function replaceExtractedFile(tempPath: string, path: string, bytes: Uint8Array): void {
    try {
        fs.rename(tempPath, path);
        return;
    } catch (e) {
        if (hasExpectedContent(path, bytes)) return;
        try { fs.unlink(path); } catch {}
        try {
            fs.rename(tempPath, path);
        } catch (e2) {
            if (!hasExpectedContent(path, bytes)) throw e2 ?? e;
        }
    }
}

function writeAll(fd: number, bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const written = fs.write(fd, bytes.subarray(offset));
        if (written <= 0) throw new Error('Failed to make progress while extracting pack contents');
        offset += written;
    }
}

function safeModuleName(specPath: string, index: number): string {
    const suffixAt = specPath.search(/[?#]/);
    const pathPart = suffixAt === -1 ? specPath : specPath.slice(0, suffixAt);
    const rawBase = basename(pathPart) || 'module';
    let clean = '';
    for (let i = 0; i < rawBase.length; i++) {
        const ch = rawBase[i]!;
        const code = ch.charCodeAt(0);
        clean += (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) || ch === '.' || ch === '_' || ch === '-'
            ? ch : '_';
    }
    return `${index}-${clean || 'module'}`;
}
