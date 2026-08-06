/** Atomic write helpers for .jspack (runtime pack is memory-only). */

const fs = import.meta.use('fs');
const os = import.meta.use('os');

let tempSeq = 0;

export function bytesEqual(actual: Uint8Array, expected: Uint8Array): boolean {
    if (actual.byteLength !== expected.byteLength) return false;
    for (let i = 0; i < expected.byteLength; i++) {
        if (actual[i] !== expected[i]) return false;
    }
    return true;
}

/** True only when the file exists and every byte matches expected. */
export function hasExpectedContent(path: string, expected: Uint8Array): boolean {
    try {
        if (fs.stat(path).size !== expected.byteLength) return false;
        return bytesEqual(new Uint8Array(fs.readFile(path)), expected);
    } catch {
        return false;
    }
}

export function writeAll(fd: number, bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const written = fs.write(fd, bytes.subarray(offset));
        if (written <= 0) throw new Error('Failed to make progress while writing pack bytes');
        offset += written;
    }
}

function tempBeside(path: string): string {
    const pid = typeof os.pid === 'number' || typeof os.pid === 'string' ? String(os.pid) : 'runtime';
    return `${path}.tmp-${pid}-${Date.now()}-${tempSeq++}`;
}

/** Parent dir of an unnormalized path; `-o dir\out.jspack` is valid on Windows. */
function parentDir(path: string): string | null {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (slash <= 0) return null;
    // `-o D:/out.jspack`: the parent IS the drive root. Slicing the separator off
    // leaves the drive-RELATIVE "D:", which does not exist as a directory —
    // ensureDir then fails with "Failed to create directory: D:".
    const c = path.charCodeAt(0);
    const isDriveRoot = slash === 2 && path[1] === ':' &&
        ((c >= 65 && c <= 90) || (c >= 97 && c <= 122));
    return isDriveRoot ? `${path.slice(0, 2)}/` : path.slice(0, slash);
}

/** temp + fsync + rename; Windows: keep healthy dest or unlink+retry. */
export function writeAtomically(path: string, bytes: Uint8Array, ensureParent: (dir: string) => void): void {
    const dir = parentDir(path);
    if (dir !== null) ensureParent(dir);
    const tempPath = tempBeside(path);
    let fd: number | null = null;
    try {
        fd = fs.open(tempPath, 'wx', 0o600);
        writeAll(fd, bytes);
        fs.fsync(fd);
        fs.close(fd);
        fd = null;
        replaceWithTemp(tempPath, path, bytes);
    } finally {
        if (fd !== null) {
            try { fs.close(fd); } catch { /* ignore */ }
        }
        try { fs.unlink(tempPath); } catch { /* ignore */ }
    }
}

/** Stream header then body chunks to path with the same atomic replace rules. */
export function writeAtomicallyStreamed(
    path: string,
    writeBody: (fd: number) => void,
    ensureParent: (dir: string) => void,
    expectedFinal?: Uint8Array,
): void {
    const dir = parentDir(path);
    if (dir !== null) ensureParent(dir);
    const tempPath = tempBeside(path);
    let fd: number | null = null;
    try {
        fd = fs.open(tempPath, 'wx', 0o600);
        writeBody(fd);
        fs.fsync(fd);
        fs.close(fd);
        fd = null;
        // For streamed pack outputs we do not re-read the full file for compare;
        // rename rules still match extract (move dest aside when it exists).
        try {
            fs.rename(tempPath, path);
        } catch {
            if (expectedFinal && hasExpectedContent(path, expectedFinal)) return;
            swapOverExisting(tempPath, path);
        }
    } finally {
        if (fd !== null) {
            try { fs.close(fd); } catch { /* ignore */ }
        }
        try { fs.unlink(tempPath); } catch { /* ignore */ }
    }
}

/** Windows rename never clobbers: park the old file, swap, restore on failure. */
function swapOverExisting(tempPath: string, path: string): void {
    const backup = `${path}.old-${tempSeq++}`;
    let parked = false;
    try { fs.rename(path, backup); parked = true; } catch { /* fall back to unlink */ }
    if (!parked) {
        try { fs.unlink(path); } catch { /* ignore */ }
    }
    try {
        fs.rename(tempPath, path);
    } catch (e) {
        // Put the previous artifact back rather than leaving no file at all.
        if (parked) { try { fs.rename(backup, path); } catch { /* ignore */ } }
        throw e;
    }
    if (parked) { try { fs.unlink(backup); } catch { /* ignore */ } }
}

function replaceWithTemp(tempPath: string, path: string, bytes: Uint8Array): void {
    try {
        fs.rename(tempPath, path);
        return;
    } catch (e) {
        if (hasExpectedContent(path, bytes)) return;
        try { fs.unlink(path); } catch { /* ignore */ }
        try {
            fs.rename(tempPath, path);
        } catch (e2) {
            if (!hasExpectedContent(path, bytes)) throw e2 ?? e;
        }
    }
}

/** Sanitize basename for extract names; never use manifest paths as filesystem paths. */
export function safeExtractBaseName(specPath: string, index: number): string {
    const suffixAt = specPath.search(/[?#]/);
    const pathPart = suffixAt === -1 ? specPath : specPath.slice(0, suffixAt);
    const slash = pathPart.lastIndexOf('/');
    const rawBase = (slash === -1 ? pathPart : pathPart.slice(slash + 1)) || 'module';
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
