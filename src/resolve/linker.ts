// resolve/linker.ts — materialize a real node_modules tree from scan edges
//
// cts resolves npm packages directly against a flat content-addressed store
// (<cacheDir>/npm/<name>@<version>/) with no real node_modules ever written
// to disk. Tools that do their own filesystem-based resolution (Vite, etc.)
// need a real tree on disk — this builds one from DepScanner's resolved
// edges. 'soft' only creates project top-level symlinks/junctions into the
// flat store; 'hard' materializes the full nested tree with per-file hard
// links, falling back to a copy only cross-volume.
//
// Regenerated on every `cno cache` run (last-writer-wins, no diffing against
// a prior run) — the in-store node_modules is shared across all projects
// using the same cache dir, which is an accepted, documented tradeoff.

import type { ScanResult } from '../deps';
import type { NodeModulesMode } from '../types';
import { joinPaths, dirname, ensureDir, log, errMsg, npmNameVersion, isWindows, hardlinkOrCopyDirRecursiveSync } from '../utils';

const fs = import.meta.use('fs');
const asyncfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');

const MANIFEST = '.cts-node-modules.json';

export async function materializeNodeModules(
    edges: ScanResult['edges'],
    mode: Exclude<NodeModulesMode, 'normal'>,
    cacheDir: string,
    projectDir: string,
    onLinked?: (done: number, total: number) => void,
): Promise<void> {
    const storeRoot = joinPaths(cacheDir, 'npm');
    const { internalEdges, rootEdges } = partitionEdges(edges);
    const pending = (mode === 'soft'
        ? rootEdges
        : [...sortInternalEdges(internalEdges), ...rootEdges])
        .filter(edge => canLinkEdge(edge, storeRoot, projectDir));

    if (mode !== 'soft') resetStorePackages(edges, storeRoot);
    resetProjectRoots(projectDir, rootEdges);

    let linked = 0;
    onLinked?.(linked, pending.length);
    for (const edge of pending) {
        await linkEdge(edge, mode, storeRoot, projectDir);
        linked++;
        onLinked?.(linked, pending.length);
    }

    writeProjectManifest(projectDir, rootEdges.map(edge => edge.name));
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
        await linkOne(linkSource, targetDir, mode);
    } catch (e) {
        log.warn('linker', () => `failed to link ${edge.name} into ${targetDir}: ${errMsg(e)}`);
    }
}

function canLinkEdge(edge: ScanResult['edges'][number], storeRoot: string, projectDir: string): boolean {
    return !!resolveTargetDir(edge, storeRoot, projectDir) && !!npmNameVersion(edge.childSpecPath);
}

async function linkOne(linkSource: string, targetDir: string, mode: Exclude<NodeModulesMode, 'normal'>): Promise<void> {
    ensureDir(dirname(targetDir));

    let existing: ReturnType<typeof fs.lstat> | null = null;
    try { existing = fs.lstat(targetDir); } catch {}
    if (existing) {
        if (mode === 'soft' && existing.isSymbolicLink) {
            try { if (fs.readlink(targetDir) === linkSource) return; } catch {}
        }
        removeExisting(targetDir, existing);
    }

    if (mode === 'soft') {
        if (isWindows) await asyncfs.symlink(linkSource, targetDir, asyncfs.SymlinkType.JUNCTION);
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
    const next = new Set(rootEdges.map(edge => edge.name));
    for (const name of previous) {
        if (!next.has(name)) removeIfExists(joinPaths(nodeModulesDir, name));
    }
}

function readProjectManifest(projectDir: string): string[] {
    const p = joinPaths(projectDir, 'node_modules', MANIFEST);
    try {
        const parsed = JSON.parse(engine.decodeString(fs.readFile(p)));
        return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

function writeProjectManifest(projectDir: string, names: string[]): void {
    const nodeModulesDir = joinPaths(projectDir, 'node_modules');
    if (!names.length && !fs.exists(nodeModulesDir)) return;
    ensureDir(nodeModulesDir);
    fs.writeFile(joinPaths(nodeModulesDir, MANIFEST), engine.encodeString(JSON.stringify([...new Set(names)].sort())));
}

function removeIfExists(p: string): void {
    let stat: ReturnType<typeof fs.lstat> | null = null;
    try { stat = fs.lstat(p); } catch {}
    if (!stat) return;
    removeExisting(p, stat);
}

function removeExisting(p: string, stat: { isDirectory: boolean; isSymbolicLink: boolean }): void {
    if (stat.isSymbolicLink) { try { fs.unlink(p); } catch {} return; }
    if (stat.isDirectory) { removeDirRecursiveSync(p); return; }
    try { fs.unlink(p); } catch {}
}

function removeDirRecursiveSync(dir: string): void {
    for (const entry of fs.readdir(dir, true)) {
        const p = joinPaths(dir, entry.name);
        if (entry.isSymbolicLink || !entry.isDirectory) { try { fs.unlink(p); } catch {} }
        else removeDirRecursiveSync(p);
    }
    try { fs.rmdir(dir); } catch {}
}
