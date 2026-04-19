// protocol/file.ts — file:// handler

import type { ModuleInfo, RuntimeConfig } from '../types';
import type { ProtocolHandler } from './base';
import { guessFileKind } from './base';
import { normalizePath } from '../utils/path';
import { detectFormat } from '../pkg';
import { fs, os } from '../utils/index';

const osname = os.uname().sysname;
export class FileHandler implements ProtocolHandler {
    readonly protocols = ['file'];
    constructor(_cfg: RuntimeConfig) {}

    resolve(spec: string, _parent: string): ModuleInfo {
        const localPath = this.strip(spec);
        // Single stat() call replaces exists() + stat() (2 syscalls → 1)
        let st;
        try { st = fs.stat(localPath); }
        catch { throw new Error(`File not found: ${localPath}`); }
        if (!st.isFile) throw new Error(`Not a file: ${localPath}`);
        return { specPath: spec, localPath, format: detectFormat(localPath), fileKind: guessFileKind(localPath) };
    }

    localPath(specPath: string): string { return this.strip(specPath); }

    private strip(url: string): string {
        let p = url.startsWith('file://') ? url.slice(7) : url;
        if (p.startsWith('/') && osname === 'win32' && p.length > 2 && p[2] === ':')
            p = p.slice(1);
        return normalizePath(p);
    }
}
