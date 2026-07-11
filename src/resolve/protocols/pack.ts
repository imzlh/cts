import type { ModuleInfo } from '../../types';
import type { ProtocolHandler } from './base';
import type { Flow } from '../../flow';
import type { PackManifest, PackModuleEntry } from '../../pack/format';
import { err, ErrorKind } from '../../errors';

// Resolves modules inside an active .jspack container: pure manifest lookups,
// no I/O — bytecode delivery is pre-seeded into JscCache's L1, see reader.ts.
export class PackHandler implements ProtocolHandler {
    readonly protocols = ['pack', 'ctsview'];

    constructor(private readonly manifest: PackManifest) {}

    *resolve(spec: string, parent: string): Flow<ModuleInfo> {
        // Self-resolve: `spec` may already be one of our own synthetic specPaths.
        const direct = this.ownModule(spec);
        if (direct) return this.toInfo(spec, direct);

        const view = this.viewInfo(spec);
        if (view) return view;

        const bucket = Object.prototype.hasOwnProperty.call(this.manifest.edges, parent)
            ? this.manifest.edges[parent]
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
        const entry = this.ownModule(specPath);
        if (entry) return entry.localPath;
        const view = this.viewInfo(specPath);
        if (view) return view.localPath;
        throw err(ErrorKind.ModuleNotFound, `Pack manifest is missing module "${specPath}"`);
    }

    private toInfo(specPath: string, entry: PackModuleEntry): ModuleInfo {
        return {
            specPath,
            localPath: entry.localPath,
            format: entry.format,
            fileKind: entry.fileKind,
            cacheBytecode: entry.sourceOnly ? false : undefined,
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
            cacheBytecode: entry.sourceOnly ? false : undefined,
        };
    }

    private ownModule(specPath: string): PackModuleEntry | undefined {
        return Object.prototype.hasOwnProperty.call(this.manifest.modules, specPath)
            ? this.manifest.modules[specPath]
            : undefined;
    }
}
