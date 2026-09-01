import type { ModuleInfo, RuntimeConfig } from '../../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { StepType, type Flow } from '../../flow';
import { fileUrlToPath, normalizePath, schemeId } from '../../utils/path';
import { detectFormat, detectPackageJsonFormat } from '../pkg';
import { err, ErrorKind } from '../../errors';

export class FileHandler implements ProtocolHandler {
    readonly protocols = ['file'];
    constructor(_cfg: RuntimeConfig) {}

    *resolve(spec: string, _parent: string): Flow<ModuleInfo> {
        const localPath = this.strip(spec);
        const exists = yield { type: StepType.FS_EXISTS, path: localPath };
        if (!exists) throw err(ErrorKind.FileNotFound, `File not found: ${localPath}`);
        return { specPath: spec, localPath, format: detectPackageJsonFormat(localPath) ?? detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string { return this.strip(specPath); }

    private strip(url: string): string {
        // fileUrlToPath owns URL query/fragment decoding and host handling.
        let p: string;
        if (schemeId(url) === 'file') {
            p = fileUrlToPath(url);
        } else {
            p = url;
        }
        return normalizePath(p);
    }
}
