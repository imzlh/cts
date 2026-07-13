import type { ScanResult } from '../deps';
import type { NodeModulesMode } from '../types';
import { joinPaths, dirname, ensureDir, errMsg, npmNameVersion, isWindows, hardlinkOrCopyDirRecursiveSync } from '../utils';

const fs = import.meta.use('fs');
const asyncfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');

const MANIFEST = '.cts-node-modules.json';

function safeUnlink(path: string): void {
    try {
        fs.unlink(path);
    } catch {}
}

function safeRmdir(path: string): void {
    try {
        fs.rmdir(path);
    } catch {}
}

export async function materializeNodeModules(
    edges: ScanResult['edges'],
    mode: Exclude<NodeModulesMode, 'normal'>,
    cacheDir: string,
    projectDir: string,
    onLinked?: (done: number, total: number) => void,
): Promise<void> {
    const storeRoot = joinPaths(cacheDir, 'npm');
    const { internalEdges, rootEdges } = partitionEdges(edges);
    const pending: ScanResult['edges'] = [];
    if (mode !== 'soft') {
        for (const edge of sortInternalEdges(internalEdges)) {
            if (canLinkEdge(edge, storeRoot, projectDir)) pending.push(edge);
        }
    }
    for (const edge of rootEdges) {
        if (canLinkEdge(edge, storeRoot, projectDir)) pending.push(edge);
    }

    if (mode !== 'soft') resetStorePackages(edges, storeRoot);
    resetProjectRoots(projectDir, rootEdges);

    let linked = 0;
    const failures: string[] = [];
    onLinked?.(linked, pending.length);
    for (const edge of pending) {
        try {
            await linkEdge(edge, mode, storeRoot, projectDir);
        } catch (e) {
            // Collect all edge failures so one bad link doesn't hide the rest.
            failures.push(errMsg(e));
        }
        linked++;
        onLinked?.(linked, pending.length);
    }

    if (failures.length > 0) {
        const head = failures.slice(0, 5).join('; ');
        const more = failures.length > 5 ? ` (+${failures.length - 5} more)` : '';
        throw new Error(
            `node_modules materialization failed (${failures.length}/${pending.length} link(s)): ${head}${more}`,
        );
    }

    writeProjectManifest(projectDir, edgeNames(rootEdges));
}

function edgeNames(edges: ScanResult['edges']): string[] {
    const names = new Array<string>(edges.length);
    for (let i = 0; i < edges.length; i++) {
        names[i] = edges[i]?.name ?? '';
    }
    return names;
}

function resolveTargetDir(edge: ScanResult['edges'][number], storeRoot: string, projectDir: string): string | null {
    if (edge.parentSpecPath.startsWith('npm:')) {
        const pv = npmNameVersion(edge.parentSpecPath);
        if (!pv) return null;
        if (pv.name === edge.name) return null;
        return joinPaths(storeRoot, `${pv.name}@${pv.version}`, 'node_modules', edge.name);
    }
    // Synthetic project-root marker (`${dir}/<cache>` or `${dir}/<entry>`,
    // see DepScanner.isEligibleParent) — link into the project's own
    // top-level node_modules.
    return joinPaths(projectDir, 'node_modules', edge.name);
}

async function linkEdge(
    edge: ScanResult['edges'][number],
    mode: Exclude<NodeModulesMode, 'normal'>,
    storeRoot: string,
    projectDir: string,
): Promise<void> {
    const targetDir = resolveTargetDir(edge, storeRoot, projectDir);
    const cv = npmNameVersion(edge.childSpecPath);
    if (!targetDir || !cv) return;
    const linkSource = joinPaths(storeRoot, `${cv.name}@${cv.version}`);
    try {
        // Soft mode uses symlink, which succeeds for a missing target and leaves
        // a dangling link — treat absent store packages as hard failures.
        if (!fs.exists(linkSource)) {
            throw new Error(`store package missing: ${linkSource}`);
        }
        await linkOne(linkSource, targetDir, mode);
    } catch (e) {
        // Fail closed: missing store / EPERM / cross-device must not look like success.
        throw new Error(`failed to link ${edge.name} into ${targetDir}: ${errMsg(e)}`, { cause: e });
    }
}

function canLinkEdge(edge: ScanResult['edges'][number], storeRoot: string, projectDir: string): boolean {
    return !!resolveTargetDir(edge, storeRoot, projectDir) && !!npmNameVersion(edge.childSpecPath);
}

async function linkOne(linkSource: string, targetDir: string, mode: Exclude<NodeModulesMode, 'normal'>): Promise<void> {
    ensureDir(dirname(targetDir));

    let existing: ReturnType<typeof fs.lstat> | null = null;
    try {
        existing = fs.lstat(targetDir);
    } catch {}
    if (existing) {
        if (mode === 'soft' && existing.isSymbolicLink) {
            try {
                if (fs.readlink(targetDir) === linkSource) return;
            } catch {}
        }
        removeExisting(targetDir, existing);
    }

    if (mode === 'soft') {
        if (isWindows) await asyncfs.symlink(linkSource, targetDir, asyncfs.FS_SYMLINK_JUNCTION);
        else fs.symlink(linkSource, targetDir);
    } else {
        hardlinkOrCopyDirRecursiveSync(linkSource, targetDir);
    }
}

function partitionEdges(edges: ScanResult['edges']): {
    internalEdges: ScanResult['edges'];
    rootEdges: ScanResult['edges'];
} {
    const internal = new Map<string, ScanResult['edges'][number]>();
    const root = new Map<string, ScanResult['edges'][number]>();

    for (const edge of edges) {
        const targetDir = edge.parentSpecPath.startsWith('npm:')
            ? `npm:${edge.parentSpecPath}->${edge.name}`
            : `root:${edge.name}`;
        if (edge.parentSpecPath.startsWith('npm:')) internal.set(targetDir, edge);
        else root.set(targetDir, edge);
    }

    return {
        internalEdges: [...internal.values()],
        rootEdges: [...root.values()],
    };
}

function sortInternalEdges(edges: ScanResult['edges']): ScanResult['edges'] {
    const deps = new Map<string, string[]>();
    for (const edge of edges) {
        const list = deps.get(edge.parentSpecPath);
        if (list) list.push(edge.childSpecPath);
        else deps.set(edge.parentSpecPath, [edge.childSpecPath]);
    }

    const memo = new Map<string, number>();
    const active = new Set<string>();
    const depthOf = (specPath: string): number => {
        const hit = memo.get(specPath);
        if (hit !== undefined) return hit;
        if (active.has(specPath)) return 0;
        active.add(specPath);
        const next = deps.get(specPath) ?? [];
        let best = 0;
        for (const child of next) {
            const d = depthOf(child) + 1;
            if (d > best) best = d;
        }
        active.delete(specPath);
        memo.set(specPath, best);
        return best;
    };

    return [...edges].sort((a, b) => {
        const da = depthOf(a.parentSpecPath);
        const db = depthOf(b.parentSpecPath);
        if (da !== db) return da - db;
        if (a.parentSpecPath !== b.parentSpecPath) return a.parentSpecPath < b.parentSpecPath ? -1 : 1;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return 0;
    });
}

function resetStorePackages(edges: ScanResult['edges'], storeRoot: string): void {
    const packages = new Set<string>();
    for (const edge of edges) {
        const cv = npmNameVersion(edge.childSpecPath);
        if (cv) packages.add(joinPaths(storeRoot, `${cv.name}@${cv.version}`, 'node_modules'));
        const pv = npmNameVersion(edge.parentSpecPath);
        if (pv) packages.add(joinPaths(storeRoot, `${pv.name}@${pv.version}`, 'node_modules'));
    }
    for (const dir of packages) removeIfExists(dir);
}

function resetProjectRoots(projectDir: string, rootEdges: ScanResult['edges']): void {
    const nodeModulesDir = joinPaths(projectDir, 'node_modules');
    const previous = readProjectManifest(projectDir);
    const next = new Set<string>();
    for (const edge of rootEdges) next.add(edge.name);
    for (const name of previous) {
        if (!next.has(name)) removeIfExists(joinPaths(nodeModulesDir, name));
    }
}

function readProjectManifest(projectDir: string): string[] {
    const p = joinPaths(projectDir, 'node_modules', MANIFEST);
    try {
        const parsed: unknown = JSON.parse(engine.decodeString(fs.readFile(p)));
        if (!Array.isArray(parsed)) return [];
        const out: string[] = [];
        for (let i = 0; i < parsed.length; i++) {
            const value = parsed[i];
            if (typeof value === 'string') out.push(value);
        }
        return out;
    } catch {
        return [];
    }
}

function writeProjectManifest(projectDir: string, names: string[]): void {
    const nodeModulesDir = joinPaths(projectDir, 'node_modules');
    if (!names.length && !fs.exists(nodeModulesDir)) return;
    ensureDir(nodeModulesDir);
    const unique = new Set<string>();
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (name) unique.add(name);
    }
    const sorted: string[] = [];
    for (const name of unique) sorted.push(name);
    sorted.sort();
    fs.writeFile(joinPaths(nodeModulesDir, MANIFEST), engine.encodeString(JSON.stringify(sorted)));
}

function removeIfExists(p: string): void {
    let stat: ReturnType<typeof fs.lstat> | null = null;
    try {
        stat = fs.lstat(p);
    } catch {}
    if (!stat) return;
    removeExisting(p, stat);
}

function removeExisting(p: string, stat: { isDirectory: boolean; isSymbolicLink: boolean }): void {
    if (stat.isSymbolicLink) {
        safeUnlink(p);
        return;
    }
    if (stat.isDirectory) {
        removeDirRecursiveSync(p);
        return;
    }
    safeUnlink(p);
}

function removeDirRecursiveSync(dir: string): void {
    for (const entry of fs.readdir(dir, true)) {
        const p = joinPaths(dir, entry.name);
        if (entry.isSymbolicLink || !entry.isDirectory) {
            safeUnlink(p);
        } else {
            removeDirRecursiveSync(p);
        }
    }
    safeRmdir(dir);
}
