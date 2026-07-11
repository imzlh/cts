import type { TypeScriptRuntime } from '../runtime/index';
import { moduleViewRef, type ModuleFormat } from '../types';
import { ParseDriver } from '../parse';
import { DepScanner } from '../deps';
import { guessFileKind } from '../resolve/protocols/base';
import { hasImportAttributes, isScannablePath, isTsLikePath } from '../scan';
import { isBuiltinSpecifier } from '../resolve/builtins';
import { relativePath, dirname, basename, ensureDir, PrecacheProgress } from '../utils';
import { err, ErrorKind } from '../errors';
import { tryLoadOxc } from '../oxc';
import { encodePackHeader, type PackManifest, type PackModuleEntry } from './format';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const os = import.meta.use('os');
const crypto = import.meta.use('crypto');
let tempFileId = 0;

interface BlobChunk {
    bytes: Uint8Array;
    offset: number;
}

interface BlobRange { offset: number; length: number }
interface SourceSnapshot extends BlobRange {
    sourceOnly: boolean;
    freshness: string;
}

class BlobBuilder {
    private readonly chunks: BlobChunk[] = [];
    private cursor = 0;

    push(bytes: Uint8Array): { offset: number; length: number } {
        const offset = this.cursor;
        const next = offset + bytes.byteLength;
        if (!Number.isSafeInteger(next)) throw new Error('pack blob is too large');
        this.chunks.push({ bytes, offset });
        this.cursor = next;
        return { offset, length: bytes.byteLength };
    }

    get byteLength(): number { return this.cursor; }

    writeTo(fd: number): void {
        let offset = 0;
        for (const chunk of this.chunks) {
            if (chunk.offset !== offset) throw new Error('pack blob chunks are not contiguous');
            writeAll(fd, chunk.bytes);
            offset += chunk.bytes.byteLength;
        }
        if (offset !== this.cursor) throw new Error('pack blob size changed while writing');
    }
}

function writeAll(fd: number, bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const written = fs.write(fd, bytes.subarray(offset));
        if (written <= 0) throw new Error('Failed to make progress while writing pack output');
        offset += written;
    }
}

function freshnessToken(path: string): string {
    const stat = fs.stat(path);
    return `${String(stat.mtim)}:${stat.size}`;
}

/** Same scheme-extraction rule as ModuleResolver's private protoOf() — 2-8
 *  lowercase-alpha chars before the first ':'. Local/Windows-drive specPaths
 *  never match (drive letters are single-char and upper-cased by canonicalizePath). */
function specScheme(specPath: string): string | null {
    const ci = specPath.indexOf(':');
    if (ci < 2 || ci > 8) return null;
    const scheme = specPath.slice(0, ci);
    for (let i = 0; i < scheme.length; i++) {
        const c = scheme.charCodeAt(i);
        if (c < 97 || c > 122) return null;
    }
    return scheme;
}

function externalLocalId(m: ScanModule): string {
    const hash = crypto.hexEncode(crypto.sha256(engine.encodeString(m.specPath)));
    const name = encodeURIComponent(basename(m.localPath) || 'module');
    return `pack:local/${hash}/${name}${localSpecifierSuffix(m)}`;
}

function localSpecifierSuffix(m: ScanModule): string {
    if (!m.specPath.startsWith(m.localPath)) return '';
    const suffix = m.specPath.slice(m.localPath.length);
    return suffix.startsWith('?') || suffix.startsWith('#') ? suffix : '';
}

function attributeViewId(id: string, baseKind: ReturnType<typeof guessFileKind>, attr?: Record<string, unknown>): string {
    const type = attr?.type;
    const view = type === 'text' ? 'text' : type === 'bytes' ? 'binary' : type === 'json' ? 'json' : baseKind;
    return view === baseKind ? id : moduleViewRef(id, view);
}

function isTypeScriptLang(lang: string): boolean {
    const normalized = (lang.startsWith('.') ? lang.slice(1) : lang).toLowerCase();
    return normalized === 'ts' || normalized === 'tsx' || normalized === 'cts' || normalized === 'mts';
}

interface ScanModule { specPath: string; localPath: string; format: ModuleFormat }

interface ClassifiedModule {
    m: ScanModule;
    id: string;
}

export interface WritePackOptions {
    /** Language override for an extensionless entry. */
    entryLang?: string;
}

/** Assign every scanned module a stable, directory-structure-preserving id:
 *  - workspace files: "pack:/<relative-path>"
 *  - everything else: "pack:<scheme>/<rest>" derived from its own specPath scheme,
 *    or "pack:local/<hash>/<basename>" for a local file outside workspace roots. */
function classifyModules(modules: ScanModule[], workspaceRoots: string[]): ClassifiedModule[] {
    const syntheticToReal = new Map<string, string>();
    const out: ClassifiedModule[] = [];

    for (const m of modules) {
        let id: string | null = null;
        for (const root of workspaceRoots) {
            const rel = relativePath(root, m.localPath);
            if (rel !== null) {
                id = `pack:/${rel}${localSpecifierSuffix(m)}`;
                break;
            }
        }
        if (id === null) {
            const scheme = specScheme(m.specPath);
            id = scheme && scheme !== 'file'
                ? `pack:${scheme}/${m.specPath.slice(scheme.length + 1)}`
                : externalLocalId(m);
        }

        const existing = syntheticToReal.get(id);
        if (existing !== undefined && existing !== m.specPath) {
            throw err(ErrorKind.Generic,
                `pack: id collision for "${id}" — both "${existing}" and "${m.specPath}" map to it. ` +
                `This is a bug in the pack module-id scheme; please report it.`);
        }
        syntheticToReal.set(id, m.specPath);
        out.push({ m, id });
    }
    return out;
}

// Packs entry + its static dep graph into a portable .jspack container, keyed
// by synthetic, directory-structure-preserving "pack:/..." / "pack:<scheme>/..." ids
// instead of pack-time absolute paths. External (non-workspace) dependencies must
// be resolvable at pack time; all source modules are compiled under their synthetic ids.
export async function writePack(
    runtime: TypeScriptRuntime,
    entrySpecifier: string,
    projectDir: string,
    outPath: string,
    options: WritePackOptions = {},
): Promise<PackManifest> {
    const oxc = runtime.config.enableOxc === false ? null : tryLoadOxc();
    const parseDriver = new ParseDriver(oxc);
    const prog = runtime.config.silent ? null : new PrecacheProgress(5, 'Packing');
    const importsByLocalPath = new Map<string, string[]>();

    try {
        const entryInfo = runtime.resolver.resolve(entrySpecifier, `${projectDir}/<pack>`);
        const recordingParseImports = async (localPath: string): Promise<string[]> => {
            const lang = localPath === entryInfo.localPath ? options.entryLang : undefined;
            const deps = isScannablePath(localPath) || lang
                ? await parseDriver.scanFile(localPath, lang, false)
                : [];
            importsByLocalPath.set(localPath, deps);
            return deps;
        };
        const scanner = new DepScanner(runtime.resolver, runtime.config, prog, oxc, recordingParseImports, {
            fullGraph: true,
            reportSummary: false,
            excludeSpecPath: specPath => specPath.startsWith('node:'),
        });
        const scanResult = await scanner.scanFromSpecifiers([entrySpecifier], projectDir);

        if (scanResult.errors.length > 0) {
            const lines = scanResult.errors
                .map(e => `  - "${e.spec}" from "${e.parent}": ${e.error}`)
                .join('\n');
            throw err(ErrorKind.ModuleNotFound,
                `pack: ${scanResult.errors.length} dependency error(s) prevented a complete bundle:\n${lines}`);
        }

        const entryDir = dirname(entryInfo.localPath);
        const workspaceRoots = entryDir === projectDir ? [projectDir] : [projectDir, entryDir];
        // Node builtins are runtime-provided — at run time `node:`/builtin specifiers
        // dispatch natively before the pack handler, so packing their polyfills is dead
        // weight. Drop them here; edges pointing at them fall away with the target.
        const packableModules = scanResult.modules.filter(m => specScheme(m.specPath) !== 'node');
        const classified = classifyModules(packableModules, workspaceRoots);

        const realToSynthetic = new Map<string, string>();
        for (const c of classified) realToSynthetic.set(c.m.specPath, c.id);

        const entryId = realToSynthetic.get(entryInfo.specPath);
        if (!entryId) throw new Error(`Pack entry "${entryInfo.specPath}" was not found by the scan`);

        const resolvedEdges = new Map<string, string>();
        for (const edge of scanResult.resolutions) {
            resolvedEdges.set(`${edge.parentSpecPath}\0${edge.specifier}`, edge.childSpecPath);
        }

        // Offline (parent, raw specifier) -> child synthetic id, using the exact
        // results produced by the dependency scan instead of lock-store side effects.
        const edges: Record<string, Record<string, string>> = Object.create(null);
        for (const { m, id: parentId } of classified) {
            const specs = importsByLocalPath.get(m.localPath);
            if (!specs || !specs.length) continue;
            const bucket: Record<string, string> = Object.create(null);
            for (const spec of specs) {
                const childSpecPath = resolvedEdges.get(`${m.specPath}\0${spec}`);
                if (childSpecPath === undefined) {
                    throw err(ErrorKind.Generic, `pack: scan omitted edge "${spec}" from "${m.specPath}"`);
                }
                const childId = realToSynthetic.get(childSpecPath);
                if (childId) bucket[spec] = childId;
                else if (!childSpecPath.startsWith('node:')) {
                    throw err(ErrorKind.Generic,
                        `pack: resolved edge target was not included: "${spec}" from "${m.specPath}" -> "${childSpecPath}"`);
                }
            }
            if (Object.keys(bucket).length > 0) edges[parentId] = bucket;
        }

        const moduleById = new Map(classified.map(c => [c.id, c.m] as const));
        const fileKindById = new Map(classified.map(c => [
            c.id,
            c.m.specPath === entryInfo.specPath && options.entryLang ? 'source' : guessFileKind(c.m.localPath),
        ] as const));
        const blob = new BlobBuilder();
        const modules: Record<string, PackModuleEntry> = Object.create(null);
        const sourceModules: Array<{
            specPath: string;
            localPath: string;
            format?: ModuleFormat;
            lang?: string;
        }> = [];
        const rawRanges = new Map<string, BlobRange>();
        const sourceSnapshots = new Map<string, SourceSnapshot>();
        const sourceRanges = new Map<string, SourceSnapshot>();

        const rawRange = (localPath: string): BlobRange => {
            const existing = rawRanges.get(localPath);
            if (existing) return existing;
            const range = blob.push(new Uint8Array(fs.readFile(localPath)));
            rawRanges.set(localPath, range);
            return range;
        };

        for (const { m, id } of classified) {
            const fileKind = fileKindById.get(id) ?? guessFileKind(m.localPath);
            if (fileKind !== 'source') {
                const { offset, length } = rawRange(m.localPath);
                modules[id] = { localPath: id, format: m.format, fileKind, offset, length };
                continue;
            }
            let snapshot = sourceSnapshots.get(m.localPath);
            if (!snapshot) {
                const freshness = freshnessToken(m.localPath);
                const source = new Uint8Array(fs.readFile(m.localPath));
                if (freshnessToken(m.localPath) !== freshness) {
                    throw err(ErrorKind.Generic, `pack: source changed while reading: ${m.localPath}`);
                }
                const range = blob.push(source);
                snapshot = {
                    ...range,
                    sourceOnly: hasImportAttributes(
                        engine.decodeString(source),
                        options.entryLang && m.specPath === entryInfo.specPath
                            ? isTypeScriptLang(options.entryLang)
                            : isTsLikePath(m.localPath),
                    ),
                    freshness,
                };
                sourceSnapshots.set(m.localPath, snapshot);
                rawRanges.set(m.localPath, range);
            }
            sourceRanges.set(id, snapshot);
            // Compile every source module (workspace + external deps) from source under
            // its synthetic id. Reusing cached .jsc is not portable: bytecode bakes in the
            // original "npm:"/"file:" identity, so at run time its imports would resolve
            // against that identity's parent and escape the container to the live cache.
            sourceModules.push({
                specPath: id,
                localPath: m.localPath,
                format: m.format,
                lang: m.specPath === entryInfo.specPath ? options.entryLang : undefined,
            });
        }

        const compileFailures: Array<{ localPath: string; specPath: string; error: unknown }> = [];

        if (sourceModules.length > 0) {
            // Throwaway placeholders so eager static-import resolution during
            // compileModules() below resolves offline, not against real files.
            const stubModules = new Map<string, CModuleEngine.Module>();
            for (const id of realToSynthetic.values()) stubModules.set(id, engine.Module.create(id));

            await runtime.withStubModuleLoader({
                resolve(spec, parent, attr) {
                    // Node builtins are excluded from the pack — they dispatch natively
                    // at run time. Give compile-time linking a native id to stub.
                    if (spec.startsWith('node:') || isBuiltinSpecifier(spec)) {
                        return spec.startsWith('node:') ? spec : `node:${spec}`;
                    }
                    const childId = edges[parent]?.[spec];
                    if (!childId) throw err(ErrorKind.ModuleNotFound, `pack: no static edge for "${spec}" from "${parent}"`);
                    const child = moduleById.get(childId);
                    return child ? attributeViewId(childId, fileKindById.get(childId) ?? guessFileKind(child.localPath), attr) : childId;
                },
                load(specPath) {
                    let mod = stubModules.get(specPath);
                    if (!mod) { mod = engine.Module.create(specPath); stubModules.set(specPath, mod); }
                    return mod;
                },
            }, () =>
                // compileForCache reports both the real local path and synthetic id.
                parseDriver.compileModules(sourceModules, (done, total) => prog?.setCompileProgress(done, total), (localPath, bc, syntheticSpecPath) => {
                    const bytes = new Uint8Array(bc);
                    const { offset, length } = blob.push(bytes);
                    const format = moduleById.get(syntheticSpecPath)?.format ?? 'esm';
                    const sourceRange = sourceRanges.get(syntheticSpecPath);
                    if (!sourceRange) {
                        compileFailures.push({ localPath, specPath: syntheticSpecPath, error: new Error('source bytes were not recorded') });
                        return;
                    }
                    modules[syntheticSpecPath] = {
                        localPath: syntheticSpecPath,
                        format,
                        fileKind: 'source',
                        offset,
                        length,
                        sourceOffset: sourceRange.offset,
                        sourceLength: sourceRange.length,
                        sourceOnly: sourceRange.sourceOnly,
                        lang: moduleById.get(syntheticSpecPath)?.specPath === entryInfo.specPath
                            ? options.entryLang
                            : undefined,
                    };
                }, (localPath, specPath, error) => {
                    compileFailures.push({ localPath, specPath, error });
                }),
            );
        }

        if (compileFailures.length > 0) {
            const lines = compileFailures
                .map(f => `  - ${f.localPath}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
                .join('\n');
            throw err(ErrorKind.TransformError, `pack: ${compileFailures.length} source module(s) failed to compile:\n${lines}`);
        }

        for (const [localPath, snapshot] of sourceSnapshots) {
            if (freshnessToken(localPath) !== snapshot.freshness) {
                throw err(ErrorKind.Generic, `pack: source changed while packing: ${localPath}`);
            }
        }

        const missing = classified.filter(c => modules[c.id] === undefined).map(c => c.id);
        if (missing.length > 0) {
            throw err(ErrorKind.TransformError,
                `pack: ${missing.length} module(s) produced no output:\n${missing.map(id => `  - ${id}`).join('\n')}`);
        }

        const manifest: PackManifest = {
            entry: entryId,
            modules,
            edges,
            bytecodeVersion: engine.versions.quickjs,
        };
        writeAtomically(outPath, manifest, blob);
        return manifest;
    } finally {
        prog?.stop();
        await parseDriver.terminate();
    }
}

function writeAtomically(outPath: string, manifest: PackManifest, blob: BlobBuilder): void {
    ensureDir(dirname(outPath));
    const pid = typeof os.pid === 'number' || typeof os.pid === 'string' ? String(os.pid) : 'runtime';
    const tempPath = `${outPath}.tmp-${pid}-${Date.now()}-${tempFileId++}`;
    let fd: number | null = null;
    try {
        const header = encodePackHeader(manifest, blob.byteLength);
        fd = fs.open(tempPath, 'w');
        writeAll(fd, header);
        blob.writeTo(fd);
        fs.fsync(fd);
        fs.close(fd);
        fd = null;
        fs.rename(tempPath, outPath);
    } finally {
        if (fd !== null) {
            try { fs.close(fd); } catch {}
        }
        try { fs.unlink(tempPath); } catch {}
    }
}
