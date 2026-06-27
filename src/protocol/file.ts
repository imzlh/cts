// protocol/file.ts - file:// handler

import type { ModuleInfo, RuntimeConfig } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { StepType, type Flow } from '../flow';
import { normalizePath } from '../utils/path';
import { detectFormat } from '../pkg';
import { isWindows } from '../utils/index';
import { err, ErrorKind } from '../errors';

export class FileHandler implements ProtocolHandler {
    readonly protocols = ['file'];
    constructor(_cfg: RuntimeConfig) {}

    *resolve(spec: string, _parent: string): Flow<ModuleInfo> {
        const localPath = this.strip(spec);
        const exists = yield { type: StepType.FS_EXISTS, path: localPath };
        if (!exists) throw err(ErrorKind.FileNotFound, `File not found: ${localPath}`);
        return { specPath: spec, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string { return this.strip(specPath); }

    private strip(url: string): string {
        let p = url.startsWith('file://') ? decodeURIComponent(url.slice(7)) : url;
        if (p.startsWith('/') && isWindows && p.length > 2 && p[2] === ':')
            p = p.slice(1);
        return normalizePath(p);
    }
}
