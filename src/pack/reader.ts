import type { ModuleResolver } from '../resolve/index';
import type { JscCache } from '../source/cache';
import { PackHandler } from '../resolve/protocols/pack';
import { decodePack, readBlob, readSourceBlob, type PackManifest } from './format';
import { ensureDir, joinPaths, dirname, basename } from '../utils';

const fs = import.meta.use('fs');
const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');

export interface LoadedPack {
    manifest: PackManifest;
}

// Loads a .jspack container: validates it, materializes bundled source/assets
// to safe generated paths, pre-seeds compatible bytecode, and registers pack:.
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
    const extractionComplete = fs.exists(completeMarker);

    let index = 0;
    for (const specPath of Object.keys(manifest.modules)) {
        const entry = manifest.modules[specPath];
        if (!entry) continue;
        const raw = entry.fileKind === 'source' ? readSourceBlob(container, entry) : readBlob(container, entry);
        const realPath = joinPaths(extractDir, safeModuleName(specPath, index++));
        if (!extractionComplete || !hasExpectedSize(realPath, raw.byteLength)) {
            ensureDir(dirname(realPath));
            fs.writeFile(realPath, raw);
        }
        if (entry.fileKind === 'source') {
            if (!entry.sourceOnly && manifest.bytecodeVersion === engine.versions.quickjs) {
                jsc.setMemory(realPath, readBlob(container, entry).slice().buffer);
            }
        }
        entry.localPath = realPath;
    }

    if (!extractionComplete) {
        ensureDir(extractDir);
        fs.writeFile(completeMarker, new Uint8Array());
    }

    resolver.registerPackHandler(new PackHandler(manifest));
    return { manifest };
}

function hasExpectedSize(path: string, size: number): boolean {
    try {
        return fs.stat(path).size === size;
    } catch {
        return false;
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
