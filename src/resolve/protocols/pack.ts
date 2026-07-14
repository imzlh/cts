import type { ModuleInfo } from '../../types';
import type { ProtocolHandler } from './base';
import type { Flow } from '../../flow';
import type { PackManifest, PackModuleEntry } from '../../pack/format';
import { err, ErrorKind } from '../../errors';

// Manifest-only resolve for an installed PackSession.
// Payload: PackBlobStore via readBytes; bytecode: store.bytecode on demand.
export class PackHandler implements ProtocolHandler {
    readonly protocols = ['pack', 'ctsview'];

    constructor(private readonly manifest: PackManifest) {}

    *resolve(spec: string, parent: string): Flow<ModuleInfo> {
        // Self-resolve: `spec` may already be one of our own synthetic specPaths.
        const direct = this.ownModule(spec);
        if (direct) return this.toInfo(spec, direct);

        const view = this.viewInfo(spec);
        if (view) return view;

        const edges = this.manifest.edges;
        const bucket = Object.prototype.hasOwnProperty.call(edges, parent)
            ? edges[parent]
            : undefined;
        const childSpecPath = bucket && Object.prototype.hasOwnProperty.call(bucket, spec)
            ? bucket[spec]
            : undefined;
        if (childSpecPath !== undefined) {
            const entry = this.ownModule(childSpecPath);
            if (entry) return this.toInfo(childSpecPath, entry);
        }

        throw err(ErrorKind.ModuleNotFound,
            `Cannot resolve "${spec}" from "${parent}" inside this .jspack — the specifier wasn't ` +
            `discoverable by static analysis when the container was built.`);
    }

    localPath(specPath: string): string {
        const info = this.getModuleInfo(specPath);
        if (info) return info.localPath;
        throw err(ErrorKind.ModuleNotFound, `Pack manifest is missing module "${specPath}"`);
    }

    /** Recover full ModuleInfo for load/init hooks (fileKind + sourceOnly flags). */
    getModuleInfo(specPath: string): ModuleInfo | null {
        const direct = this.ownModule(specPath);
        if (direct) return this.toInfo(specPath, direct);
        return this.viewInfo(specPath);
    }

    private toInfo(specPath: string, entry: PackModuleEntry): ModuleInfo {
        return {
            specPath,
            localPath: entry.localPath,
            format: entry.format,
            fileKind: entry.fileKind,
            // Serialized bytecode drops import-attribute semantics; never cache.
            cacheBytecode: entry.sourceOnly || entry.fileKind !== 'source' ? false : undefined,
            // Extensionless pack entries need lang on ABI-mismatch recompile.
            lang: entry.lang,
        };
    }

    private viewInfo(specPath: string): ModuleInfo | null {
        if (!specPath.startsWith('ctsview:')) return null;
        const slash = specPath.indexOf('/', 'ctsview:'.length);
        if (slash === -1) return null;
        const fileKind = specPath.slice('ctsview:'.length, slash);
        let base: string;
        try {
            base = decodeURIComponent(specPath.slice(slash + 1));
        } catch {
            return null;
        }
        const entry = this.ownModule(base);
        if (!entry) return null;
        if (fileKind !== 'text' && fileKind !== 'binary' && fileKind !== 'json') return null;
        return {
            specPath,
            localPath: entry.localPath,
            format: entry.format,
            fileKind,
            // Views share the base VFS path — never use source bytecode.
            cacheBytecode: false,
            moduleId: specPath,
        };
    }

    private ownModule(specPath: string): PackModuleEntry | undefined {
        return Object.prototype.hasOwnProperty.call(this.manifest.modules, specPath)
            ? this.manifest.modules[specPath]
            : undefined;
    }
}
