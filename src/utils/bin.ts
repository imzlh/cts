import { joinPaths, dirname, pathRoot, toPosixPath } from './path';
import { isWindows } from './platform';

const fs = import.meta.use('fs');

/** Windows wrapper extensions, checked in preference order. */
export const WIN_BIN_EXTS = ['.cmd', '.CMD', '.bat', '.BAT'];

/** Walk up for node_modules/.bin/<name> (.cmd/.BAT preferred on Windows). */
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
