// utils/bin.ts — shared node_modules/.bin resolution

import { joinPaths, dirname, pathRoot, toPosixPath } from './path';
import { isWindows } from './platform';

const fs = import.meta.use('fs');

/** Windows wrapper extensions, checked in preference order. */
export const WIN_BIN_EXTS = ['.cmd', '.CMD', '.bat', '.BAT'];

/**
 * Walk up from `cwd` looking for `node_modules/.bin/<name>`.
 * On Windows, also checks `.cmd` / `.BAT` wrappers (preferred over bare shims).
 *
 * Returns the first match found, or null.
 */
export function findLocalBin(name: string, cwd: string): string | null {
    let dir = toPosixPath(cwd);
    const root = pathRoot(dir);
    while (true) {
        const base = joinPaths(dir, 'node_modules', '.bin', name);
        if (isWindows) {
            // On Windows, prefer .cmd/.bat wrappers over POSIX shell shims.
            for (const ext of WIN_BIN_EXTS) {
                const c = base + ext;
                if (fs.exists(c)) return c;
            }
        }
        if (fs.exists(base)) return base;
        if (dir === root) break;
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}
