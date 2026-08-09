import type { TypeScriptRuntime } from '../runtime/index';
import type { ModuleFormat, FileKind } from '../types';
import { ParseDriver } from '../parse';
import { DepScanner } from '../deps';
import { guessFileKind } from '../resolve/protocols/base';
import { hasImportAttributes, isTsLikePath } from '../scan';
import { isBuiltinSpecifier } from '../resolve/builtins';
import { relativePath, dirname, basename, canonicalizePath, ensureDir, PrecacheProgress, log } from '../utils';
import { err, ErrorKind } from '../errors';
import { encodePackHeader, completePackManifest, type PackBlobSource, type PackManifest, type PackModuleEntry } from './format';
import { writeAll, writeAtomicallyStreamed } from './integrity';
import { attributeViewId, specScheme } from './identity';
import { stripSourceMappingURL } from './sourcemap';

const fs = import.meta.use('fs');
const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

interface BlobChunk {
    bytes: Uint8Array;
    offset: number;
}

interface BlobRange { offset: number; length: number }
interface SourceSnapshot extends BlobRange {
    sourceOnly: boolean;
    /** Digest of the ON-DISK bytes, for the pack-time change check. */
    digest: string;
    /** Embedded text after sourceMappingURL stripping.
     *
     *  Currently UNUSED at the compile step, and kept deliberately: it is exactly
     *  the text that has to reach the compiler to close the bytecode-sourcemap
     *  gap documented at the sourceModules.push below. Nothing reads it today, so
     *  do not treat its presence as evidence the gap is closed. */
    code: string;
}

class BlobBuilder implements PackBlobSource {
    private readonly chunks: BlobChunk[] = [];
    /** offset -> chunk bytes, for serving digest reads without materializing the
     *  whole blob. Zero-length chunks are excluded: they address no bytes, so
     *  several can share an offset and none needs a lookup. */
    private readonly byOffset = new Map<number, Uint8Array>();
    private cursor = 0;

    push(bytes: Uint8Array): { offset: number; length: number } {
        const offset = this.cursor;
        const next = offset + bytes.byteLength;
        if (!Number.isSafeInteger(next)) throw new Error('pack blob is too large');
        this.chunks.push({ bytes, offset });
        if (bytes.byteLength > 0) this.byOffset.set(offset, bytes);
        this.cursor = next;
        return { offset, length: bytes.byteLength };
    }

    get byteLength(): number { return this.cursor; }

    /** Exact bytes of one appended chunk. Only whole chunks are addressable,
     *  which is precisely what the manifest declares: every range in it came
     *  from one push() above. A partial or straddling range means the manifest
     *  and the builder have desynced, so refuse rather than silently hash the
     *  wrong bytes. */
    range(offset: number, length: number): Uint8Array {
        if (length === 0) return new Uint8Array(0);
        const chunk = this.byOffset.get(offset);
        if (chunk === undefined || chunk.byteLength !== length) {
            throw new Error(
                `pack blob range ${offset}+${length} does not match an appended chunk ` +
                `(manifest and blob builder disagree)`);
        }
        return chunk;
    }

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

function contentDigest(bytes: Uint8Array): string {
    return crypto.hexEncode(crypto.sha256(bytes));
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

function isTypeScriptLang(lang: string): boolean {
    const normalized = (lang.startsWith('.') ? lang.slice(1) : lang).toLowerCase();
    return normalized === 'ts' || normalized === 'tsx' || normalized === 'cts' || normalized === 'mts';
}

interface ScanModule {
    specPath: string;
    localPath: string;
    format: ModuleFormat;
    fileKind?: FileKind;
}

interface ClassifiedModule {
    m: ScanModule;
    id: string;
}

export interface WritePackOptions {
    /** Language override for an extensionless entry. */
    entryLang?: string;
}

/** Stable pack id: pack:/rel, pack:<scheme>/…, or pack:local/<hash>/base. */
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
        // ModuleResolver canonicalizes every specifier before the manifest
        // lookup, so an id that is not already in canonical form would produce
        // an artifact whose modules are unreachable at run time. Sources feeding
        // the ids above are canonical today; pin the invariant here so a future
        // change fails as a pack-time id collision instead of a broken .jspack.
        id = canonicalizePath(id);

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

// Entry + static graph → .jspack under synthetic pack: ids (externals must resolve at pack time).
export async function writePack(
    runtime: TypeScriptRuntime,
    entrySpecifier: string,
    projectDir: string,
    outPath: string,
    options: WritePackOptions = {},
): Promise<PackManifest> {
    // Reuse the runtime's oxc (createRuntime already tried tryLoadOxc).
    const oxc = runtime.getOxc();
    // Transform workers + compileForCache on main; oxc import-scan stays main-thread.
    const parseDriver = new ParseDriver(oxc);
    const prog = runtime.config.silent ? null : new PrecacheProgress(5, 'Packing');
    log.debug('pack', () =>
        `pipeline: scan=${oxc ? 'oxc-main' : 'sucrase+workers'} ` +
        `transform=${oxc ? 'oxc+workers' : 'sucrase+workers'} compile=main`);

    try {
        const entryInfo = runtime.resolver.resolve(entrySpecifier, `${projectDir}/<pack>`);
        // Offline edges come only from scanResult.resolutions (JS/TS + WASM).
        // entryLang needs ParseDriver; otherwise oxc-main uses sync ImportScanner.
        const needsLangScan = options.entryLang !== undefined;
        const parseImports = needsLangScan
            ? async (localPath: string): Promise<string[]> => {
                const lang = localPath === entryInfo.localPath ? options.entryLang : undefined;
                return parseDriver.scanFile(localPath, lang, true);
            }
            : null;
        const scanner = new DepScanner(runtime.resolver, runtime.config, prog, oxc, parseImports, {
            fullGraph: true,
            reportSummary: false,
            excludeSpecPath: specPath => specPath.startsWith('node:'),
            fileKindOverrides: options.entryLang
                ? new Map<string, FileKind>([[entryInfo.specPath, 'source']])
                : undefined,
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
        // Drop node builtins (runtime-provided; packing polyfills is dead weight).
        const packableModules = scanResult.modules.filter(m => specScheme(m.specPath) !== 'node');
        const classified = classifyModules(packableModules, workspaceRoots);
        classified.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

        const realToSynthetic = new Map<string, string>();
        for (const c of classified) realToSynthetic.set(c.m.specPath, c.id);

        const entryId = realToSynthetic.get(entryInfo.specPath);
        if (!entryId) throw new Error(`Pack entry "${entryInfo.specPath}" was not found by the scan`);

        // Edges = scan resolutions only; never re-parse (would drop non-source).
        const edges: Record<string, Record<string, string>> = Object.create(null);
        for (const edge of scanResult.resolutions) {
            // Synthetic BFS parents are not packed modules.
            if (edge.parentSpecPath.endsWith('/<cache>') ||
                edge.parentSpecPath.endsWith('/<pack>') ||
                edge.parentSpecPath.endsWith('/<entry>')) {
                continue;
            }
            const parentId = realToSynthetic.get(edge.parentSpecPath);
            if (!parentId) continue;
            const childId = realToSynthetic.get(edge.childSpecPath);
            if (childId) {
                let bucket = edges[parentId];
                if (!bucket) {
                    bucket = Object.create(null);
                    edges[parentId] = bucket!;
                }
                bucket![edge.specifier] = childId;
            } else if (!edge.childSpecPath.startsWith('node:')) {
                throw err(ErrorKind.Generic,
                    `pack: resolved edge target was not included: "${edge.specifier}" from "${edge.parentSpecPath}" -> "${edge.childSpecPath}"`);
            }
        }
        // Stable specifier order inside each parent bucket.
        for (const parentId of Object.keys(edges)) {
            const bucket = edges[parentId]!;
            const keys = Object.keys(bucket).sort();
            const ordered: Record<string, string> = Object.create(null);
            for (const k of keys) ordered[k] = bucket[k]!;
            edges[parentId] = ordered;
        }

        const moduleById = new Map(classified.map(c => [c.id, c.m] as const));
        const fileKindById = new Map(classified.map(c => [
            c.id,
            c.m.specPath === entryInfo.specPath && options.entryLang
                ? 'source'
                : c.m.fileKind ?? guessFileKind(c.m.localPath),
        ] as const));
        const blob = new BlobBuilder();
        const modules: Record<string, PackModuleEntry> = Object.create(null);
        const sourceModules: Array<{
            specPath: string;
            localPath: string;
            format?: ModuleFormat;
            lang?: string;
            identity?: string;
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
                const onDisk = new Uint8Array(fs.readFile(m.localPath));
                // Strip `sourceMappingURL` before the bytes reach the artifact.
                // An inline map carries the build machine's absolute paths and
                // the full pre-build original in base64 — invisible to a grep of
                // the .jspack. See ./sourcemap.ts for why this is unconditional.
                const stripped = stripSourceMappingURL(engine.decodeString(onDisk));
                const source = stripped.removed > 0 ? engine.encodeString(stripped.text) : onDisk;
                if (stripped.removed > 0) {
                    log.debug('pack', () => `stripped ${stripped.removed} sourceMappingURL annotation(s) from ${m.localPath}`);
                }
                const range = blob.push(source);
                snapshot = {
                    ...range,
                    sourceOnly: hasImportAttributes(
                        stripped.text,
                        options.entryLang && m.specPath === entryInfo.specPath
                            ? isTypeScriptLang(options.entryLang)
                            : isTsLikePath(m.localPath),
                    ),
                    // Change detection must hash what is ON DISK, not what was
                    // embedded: the re-read below compares against the file, so
                    // digesting the stripped bytes would report "source changed
                    // while packing" for every module that had an annotation.
                    digest: contentDigest(onDisk),
                    code: stripped.text,
                };
                sourceSnapshots.set(m.localPath, snapshot);
                // Deliberately NOT registered in rawRanges. That map backs
                // non-source (text/binary/json) views, whose contract is the
                // file's verbatim bytes; aliasing them onto this stripped range
                // would silently serve an asset the rewritten text. The cost is
                // one duplicated blob range for a file imported both as source
                // and as an asset, which validateBlobLayout allows as dedup.
            }
            sourceRanges.set(id, snapshot);
            // Compile under pack: ids; host .jsc is not portable (bakes npm:/file: identity).
            // `identity` is the eval filename baked into the bytecode atom table: it must
            // be the pack id, never localPath, or the artifact carries the pack-time
            // absolute host path (CJS defaults to localPath for on-disk caches).
            //
            // KNOWN GAP, measured — do not read the stripping below as complete.
            // `stripSourceMappingURL` cleans the bytes that go into the *source*
            // blob range, and that part works. It does NOT clean bytecode:
            // ParseDriver re-reads the file from disk to compile (parse.ts:637 for
            // CJS, :542 inline), and QuickJS keeps the CJS wrapper's function
            // source inside the bytecode, so a CJS module that had an inline map
            // ships a second copy of it inside its bytecode range — build-machine
            // absolute paths and the base64 pre-build original included.
            //
            // Measured on a two-module CJS fixture: the embedded source ranges
            // were clean, and `pack:/lib.cjs`'s BYTECODE range still contained the
            // annotation, decoding to the build path. Closing it means plumbing
            // the stripped text through CompileTarget (parse.ts:58, which has no
            // `code` member) into both compile paths. A `code: snapshot.code`
            // property used to be passed here for exactly that purpose, but
            // nothing ever read it — it was silently dropped as an unknown
            // property, which is what the long-standing tsc error on this call
            // was reporting.
            sourceModules.push({
                specPath: id,
                localPath: m.localPath,
                format: m.format,
                lang: m.specPath === entryInfo.specPath ? options.entryLang : undefined,
                identity: id,
            });
        }

        const compileFailures: Array<{ localPath: string; specPath: string; error: unknown }> = [];
        const compiled = new Map<string, Uint8Array>();

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
                    if (compiled.has(syntheticSpecPath)) {
                        compileFailures.push({ localPath, specPath: syntheticSpecPath, error: new Error('duplicate compiler output') });
                        return;
                    }
                    compiled.set(syntheticSpecPath, new Uint8Array(bc));
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

        // Sorted append for stable layout; fail if any source lacks compile+snapshot.
        for (const sourceModule of sourceModules) {
            const output = compiled.get(sourceModule.specPath);
            const sourceRange = sourceRanges.get(sourceModule.specPath);
            if (!output || !sourceRange) {
                if (!compileFailures.some(f => f.specPath === sourceModule.specPath)) {
                    compileFailures.push({
                        localPath: sourceModule.localPath,
                        specPath: sourceModule.specPath,
                        error: new Error(!output ? 'compiler produced no bytecode' : 'source snapshot missing'),
                    });
                }
                continue;
            }
            const { offset, length } = blob.push(output);
            const source = moduleById.get(sourceModule.specPath);
            modules[sourceModule.specPath] = {
                localPath: sourceModule.specPath,
                format: source?.format ?? 'esm',
                fileKind: 'source',
                offset,
                length,
                sourceOffset: sourceRange.offset,
                sourceLength: sourceRange.length,
                // Explicit false omitted to keep manifests small; true is required
                // so loaders disable bytecode that would drop import attributes.
                sourceOnly: sourceRange.sourceOnly || undefined,
                lang: source?.specPath === entryInfo.specPath ? options.entryLang : undefined,
            };
        }

        if (compileFailures.length > 0) {
            const lines = compileFailures
                .map(f => `  - ${f.localPath}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
                .join('\n');
            throw err(ErrorKind.TransformError, `pack: ${compileFailures.length} source module(s) failed to compile:\n${lines}`);
        }

        for (const [localPath, snapshot] of sourceSnapshots) {
            const current = new Uint8Array(fs.readFile(localPath));
            if (contentDigest(current) !== snapshot.digest) {
                throw err(ErrorKind.Generic, `pack: source changed while packing: ${localPath}`);
            }
        }

        const missing = classified.filter(c => modules[c.id] === undefined).map(c => c.id);
        if (missing.length > 0) {
            throw err(ErrorKind.TransformError,
                `pack: ${missing.length} module(s) produced no output:\n${missing.map(id => `  - ${id}`).join('\n')}`);
        }

        // Stable key order for modules and edges so identical graphs encode
        // byte-identical JSON regardless of Map/Object insertion quirks.
        const orderedModules: Record<string, PackModuleEntry> = Object.create(null);
        const orderedEdges: Record<string, Record<string, string>> = Object.create(null);
        for (const { id } of classified) {
            orderedModules[id] = modules[id]!;
            const bucket = edges[id];
            if (bucket) orderedEdges[id] = bucket;
        }

        const manifest: PackManifest = {
            entry: entryId,
            modules: orderedModules,
            edges: orderedEdges,
            bytecodeVersion: engine.versions.quickjs,
        };
        // Return what actually went on disk, digests included, rather than the
        // pre-digest draft: callers report on this object (the `cno pack` size
        // table) and it should not disagree with the artifact.
        const written = writeAtomically(outPath, manifest, blob);
        return written;
    } finally {
        // Stop progress producer before closing UI.
        try {
            await parseDriver.terminate();
        } finally {
            prog?.stop();
        }
    }
}

/** Write the container and return the manifest as it was serialized, with
 *  blobLength and per-module digests filled in by completePackManifest.
 *
 *  Ordering constraint: writeAtomicallyStreamed emits the header before the
 *  blob, and the header carries the manifest digest, which covers the manifest
 *  including every per-module digest. So all blob digests must exist before the
 *  first byte is written. BlobBuilder holds its chunks in memory and serves them
 *  through PackBlobSource.range, so the pre-pass is a hash over buffers already
 *  in hand — no extra I/O, and the blob is still streamed rather than
 *  concatenated. */
function writeAtomically(outPath: string, manifest: PackManifest, blob: BlobBuilder): PackManifest {
    const completed = completePackManifest(manifest, blob);
    const header = encodePackHeader(completed, blob);
    writeAtomicallyStreamed(outPath, (fd) => {
        writeAll(fd, header);
        blob.writeTo(fd);
    }, ensureDir);
    return completed;
}
