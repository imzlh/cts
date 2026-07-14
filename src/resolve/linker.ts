import type { ScanResult } from '../deps';
import type { NodeModulesMode, PackageJson } from '../types';
import {
    joinPaths, dirname, ensureDir, errMsg, npmNameVersion, isWindows,
    hardlinkOrCopyDirRecursive, readText, safeParse, matchLatestVersion,
    yieldEventLoop,
} from '../utils';
import { getBinMap } from './pkg';

const fs = import.meta.use('fs');
const asyncfs = import.meta.use('asyncfs');
const engine = import.meta.use('engine');

const MANIFEST = '.cts-node-modules.json';
/** Project-local virtual store (pnpm-style); bodies hardlinked once per id. */
const VIRTUAL_STORE = '.cts';
/** Sidecar next to virtual body: store package.json size+mtime for skip. */
const BODY_STAMP = '.cts-body-stamp';
/** Hard: one body tree per unique package — higher concurrency is safe. */
const HARD_LINK_CONCURRENCY = 8;
const SOFT_LINK_CONCURRENCY = 8;

type ScanEdge = ScanResult['edges'][number];

/**
 * Read-only install-graph edge (parent → dep store dir). Used for inspection /
 * tests. Materialize does not write these into the store.
 */
export interface ViewEdge {
    parentName: string;
    parentVersion: string;
    depName: string;
    /** Absolute path to the resolved store package directory. */
    depDir: string;
    /** When true, missing store target is skipped (optional peer/dep). */
    optional: boolean;
}

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

/**
 * Materialize a project-local node_modules tree.
 *
 * Store packages are read-only here. Install owns store-internal soft links
 * (`parent/node_modules/dep` → store). Materialize never writes under the store.
 *
 * soft — project-root symlinks/junctions into the flat store only.
 * hard — pnpm-style virtual store under `node_modules/.cts/`:
 *        each name@version body is hard-linked once; dependency edges and
 *        project roots are soft links into that virtual store. Store stays
 *        read-only.
 *
 * Fail closed on missing required store packages / link errors.
 * Optional `onLinked` is pure counters — not a UI API.
 */
export async function materializeNodeModules(
    edges: ScanEdge[],
    mode: Exclude<NodeModulesMode, 'normal'>,
    cacheDir: string,
    projectDir: string,
    onLinked?: (done: number, total: number) => void,
): Promise<void> {
    const storeRoot = joinPaths(cacheDir, 'npm');
    const { rootEdges } = partitionRootEdges(edges);

    const pendingRoots: ScanEdge[] = [];
    for (const edge of rootEdges) {
        if (canLinkRootEdge(edge, storeRoot, projectDir)) pendingRoots.push(edge);
    }

    // Only project-level roots are pruned against the previous manifest.
    resetProjectRoots(projectDir, rootEdges);

    // Read-only completeness check (no store writes). Soft/hard both need the
    // install graph packages present; nested soft links are install-owned.
    const graphMissing = findMissingRequiredDeps(pendingRoots, storeRoot);
    if (graphMissing.length) {
        const head = graphMissing.slice(0, 5).join('; ');
        const more = graphMissing.length > 5 ? ` (+${graphMissing.length - 5} more)` : '';
        throw new Error(
            `node_modules materialization failed (${graphMissing.length} missing): ${head}${more}`,
        );
    }

    let linked = 0;
    const failures: string[] = [];
    const concurrency = mode === 'hard' ? HARD_LINK_CONCURRENCY : SOFT_LINK_CONCURRENCY;

    if (mode === 'soft') {
        const total = pendingRoots.length;
        onLinked?.(0, total);
        await mapPool(pendingRoots, concurrency, async (edge) => {
            try {
                await linkProjectRootSoft(edge, storeRoot, projectDir);
            } catch (e) {
                failures.push(errMsg(e));
            }
            linked++;
            onLinked?.(linked, total);
        });
    } else {
        try {
            linked = await materializeHardVirtual(
                pendingRoots, storeRoot, projectDir, concurrency, onLinked,
            );
        } catch (e) {
            failures.push(errMsg(e));
        }
    }

    if (failures.length > 0) {
        const head = failures.slice(0, 5).join('; ');
        const more = failures.length > 5 ? ` (+${failures.length - 5} more)` : '';
        throw new Error(
            `node_modules materialization failed (${failures.length} link(s)): ${head}${more}`,
        );
    }

    // Project .bin is not part of the install graph (bin maps live in package.json).
    materializeProjectBins(rootEdges, storeRoot, projectDir);

    writeProjectManifest(projectDir, edgeNames(rootEdges));
}

/** Bounded concurrent map. Yields occasionally so the event loop stays responsive. */
async function mapPool<T>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    if (!items.length) return;
    const limit = Math.max(1, Math.min(concurrency, items.length));
    let next = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < limit; w++) {
        workers.push((async () => {
            for (;;) {
                const i = next++;
                if (i >= items.length) return;
                await fn(items[i]!, i);
                if ((i & 7) === 7) await yieldEventLoop();
            }
        })());
    }
    await Promise.all(workers);
}

/** Read-only BFS: required package.json deps must exist in the store. */
function findMissingRequiredDeps(roots: ScanEdge[], storeRoot: string): string[] {
    const missing: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ name: string; version: string; dir: string }> = [];

    for (const edge of roots) {
        const cv = npmNameVersion(edge.childSpecPath);
        if (!cv) continue;
        const dir = joinPaths(storeRoot, `${cv.name}@${cv.version}`);
        if (!fs.exists(joinPaths(dir, 'package.json'))) {
            missing.push(`store package missing: ${cv.name}@${cv.version}`);
            continue;
        }
        queue.push({ name: cv.name, version: cv.version, dir });
    }

    while (queue.length > 0) {
        const pkg = queue.shift()!;
        const id = `${pkg.name}@${pkg.version}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const manifest = readPkgJsonFull(pkg.dir);
        if (!manifest) continue;
        for (const dep of collectDeclaredDeps(manifest)) {
            if (dep.optional) continue;
            const depDir = resolveStorePackage(storeRoot, dep.name, dep.range, pkg.dir);
            if (!depDir) {
                missing.push(`${dep.name} (required by ${id})`);
                continue;
            }
            const cv = packageIdFromDir(storeRoot, depDir, dep.name);
            if (!cv) continue;
            const childId = `${cv.name}@${cv.version}`;
            if (!seen.has(childId)) queue.push({ name: cv.name, version: cv.version, dir: depDir });
        }
    }
    return missing;
}

interface HardPkg {
    name: string;
    version: string;
    storeDir: string;
}

/** Unique install-graph packages reachable from project roots (global seen). */
function collectHardPackages(roots: ScanEdge[], storeRoot: string): HardPkg[] {
    const out: HardPkg[] = [];
    const seen = new Set<string>();
    const queue: HardPkg[] = [];

    for (const edge of roots) {
        const cv = npmNameVersion(edge.childSpecPath);
        if (!cv) continue;
        const dir = joinPaths(storeRoot, `${cv.name}@${cv.version}`);
        if (!fs.exists(joinPaths(dir, 'package.json'))) continue;
        const id = `${cv.name}@${cv.version}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const pkg = { name: cv.name, version: cv.version, storeDir: dir };
        out.push(pkg);
        queue.push(pkg);
    }

    while (queue.length > 0) {
        const pkg = queue.shift()!;
        const manifest = readPkgJsonFull(pkg.storeDir);
        if (!manifest) continue;
        for (const dep of collectDeclaredDeps(manifest)) {
            const depDir = resolveStorePackage(storeRoot, dep.name, dep.range, pkg.storeDir);
            if (!depDir) continue;
            const cv = packageIdFromDir(storeRoot, depDir, dep.name);
            if (!cv) continue;
            const id = `${cv.name}@${cv.version}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const child = { name: cv.name, version: cv.version, storeDir: depDir };
            out.push(child);
            queue.push(child);
        }
    }
    return out;
}

/** pnpm-like key: `@scope/name@1.0.0` → `@scope+name@1.0.0`. */
function virtualStoreKey(name: string, version: string): string {
    return `${name.replace(/\//g, '+')}@${version}`;
}

function virtualPkgRoot(projectDir: string, name: string, version: string): string {
    return joinPaths(projectDir, 'node_modules', VIRTUAL_STORE, virtualStoreKey(name, version));
}

/** Package body dir inside the virtual store (…/node_modules/<name>). */
function virtualBodyDir(projectDir: string, name: string, version: string): string {
    return joinPaths(virtualPkgRoot(projectDir, name, version), 'node_modules', name);
}

/**
 * Hard materialize (pnpm-aligned, incremental):
 * 1. Inventory `.cts` — prune keys not in the current unique package set
 * 2. Per package: skip body if stamp matches store package.json; else rebuild
 * 3. Soft-link deps (bounded concurrency) under each virtual node_modules
 * 4. Soft-link project roots → virtual bodies
 * Never writes under the flat cache store. Never full-wipe `.cts` as the only path.
 */
async function materializeHardVirtual(
    roots: ScanEdge[],
    storeRoot: string,
    projectDir: string,
    concurrency: number,
    onLinked?: (done: number, total: number) => void,
): Promise<number> {
    const packages = collectHardPackages(roots, storeRoot);
    const desiredKeys = new Set<string>();
    for (const pkg of packages) desiredKeys.add(virtualStoreKey(pkg.name, pkg.version));

    const virtualRoot = joinPaths(projectDir, 'node_modules', VIRTUAL_STORE);
    ensureDir(virtualRoot);
    pruneVirtualOrphans(virtualRoot, desiredKeys);

    // Soft jobs: one unit per edge + one per project root (progress must cover tail).
    type SoftJob = { source: string; target: string; label: string; optional: boolean };
    const softJobs: SoftJob[] = [];
    for (const pkg of packages) {
        const manifest = readPkgJsonFull(pkg.storeDir);
        if (!manifest) continue;
        const nm = joinPaths(virtualPkgRoot(projectDir, pkg.name, pkg.version), 'node_modules');
        for (const dep of collectDeclaredDeps(manifest)) {
            const depDir = resolveStorePackage(storeRoot, dep.name, dep.range, pkg.storeDir);
            if (!depDir) {
                if (dep.optional) continue;
                throw new Error(
                    `store package missing for ${dep.name} (required by ${pkg.name}@${pkg.version})`,
                );
            }
            const cv = packageIdFromDir(storeRoot, depDir, dep.name);
            if (!cv) {
                if (dep.optional) continue;
                throw new Error(
                    `store package missing for ${dep.name} (required by ${pkg.name}@${pkg.version})`,
                );
            }
            softJobs.push({
                source: virtualBodyDir(projectDir, cv.name, cv.version),
                target: joinPaths(nm, dep.name),
                label: `${dep.name} under ${pkg.name}@${pkg.version}`,
                optional: dep.optional,
            });
        }
    }
    for (const edge of roots) {
        const targetDir = resolveRootTargetDir(edge, projectDir);
        const cv = npmNameVersion(edge.childSpecPath);
        if (!targetDir || !cv) continue;
        softJobs.push({
            source: virtualBodyDir(projectDir, cv.name, cv.version),
            target: targetDir,
            label: `root ${cv.name}@${cv.version}`,
            optional: false,
        });
    }

    const total = Math.max(1, packages.length + softJobs.length);
    onLinked?.(0, total);

    let linked = 0;
    const failures: string[] = [];
    const bump = () => {
        linked++;
        onLinked?.(linked, total);
    };

    // Phase 1: bodies — skip when stamp matches store package.json size+mtime.
    await mapPool(packages, concurrency, async (pkg) => {
        try {
            const body = virtualBodyDir(projectDir, pkg.name, pkg.version);
            const stampPath = joinPaths(virtualPkgRoot(projectDir, pkg.name, pkg.version), BODY_STAMP);
            if (canSkipHardBody(pkg.storeDir, body, stampPath)) {
                bump();
                return;
            }
            // Rebuild: drop stale body only (not whole virtual store).
            removeIfExists(body);
            ensureDir(dirname(body));
            await hardlinkOrCopyDirRecursive(pkg.storeDir, body, {
                skipNames: ['node_modules'],
                yieldEvery: 256,
                yieldMs: 50,
            });
            writeBodyStamp(stampPath, pkg.storeDir);
            bump();
        } catch (e) {
            failures.push(`${pkg.name}@${pkg.version}: ${errMsg(e)}`);
        }
    });
    if (failures.length) {
        throw new Error(failures.slice(0, 5).join('; '));
    }

    // Phase 2+3: dependency edges and project roots (bounded concurrency).
    await mapPool(softJobs, concurrency, async (job) => {
        try {
            if (!fs.exists(joinPaths(job.source, 'package.json'))) {
                if (job.optional) {
                    bump();
                    return;
                }
                throw new Error(`virtual package missing for ${job.label}: ${job.source}`);
            }
            await placeSoftLink(job.source, job.target);
            bump();
        } catch (e) {
            if (job.optional) {
                bump();
                return;
            }
            failures.push(`${job.label}: ${errMsg(e)}`);
        }
    });
    if (failures.length) {
        throw new Error(failures.slice(0, 5).join('; '));
    }

    if (linked < total) onLinked?.(total, total);
    return linked;
}

/** Store package.json size + mtime ms — skip body only when both match stamp. */
function storePkgFingerprint(storeDir: string): { size: number; mtimeMs: number } | null {
    try {
        const st = fs.stat(joinPaths(storeDir, 'package.json'));
        const m = st.mtim;
        const raw = m instanceof Date ? m.getTime() : Number(m);
        // Floor so re-read stamps compare stably across Date/number paths.
        return { size: st.size, mtimeMs: Math.floor(raw) };
    } catch {
        return null;
    }
}

/** Skip when body package.json exists and stamp matches current store package.json. */
function canSkipHardBody(storeDir: string, bodyDir: string, stampPath: string): boolean {
    if (!fs.exists(joinPaths(bodyDir, 'package.json'))) return false;
    const fp = storePkgFingerprint(storeDir);
    if (!fp) return false;
    try {
        const raw = engine.decodeString(fs.readFile(stampPath));
        const lines = raw.split('\n');
        const size = Number(lines[0]);
        const mtimeMs = Number(lines[1]);
        return size === fp.size && mtimeMs === fp.mtimeMs;
    } catch {
        return false;
    }
}

function writeBodyStamp(stampPath: string, storeDir: string): void {
    const fp = storePkgFingerprint(storeDir);
    if (!fp) return;
    ensureDir(dirname(stampPath));
    fs.writeFile(stampPath, engine.encodeString(`${fp.size}\n${fp.mtimeMs}\n`));
}

/** Drop virtual-store keys not in the desired install graph. */
function pruneVirtualOrphans(virtualRoot: string, desiredKeys: Set<string>): void {
    let keys: string[] = [];
    try {
        keys = fs.readdir(virtualRoot);
    } catch {
        return;
    }
    for (const key of keys) {
        if (desiredKeys.has(key)) continue;
        removeIfExists(joinPaths(virtualRoot, key));
    }
}

/**
 * Read-only install-graph edges from package.json deps/peers.
 * Seeds from scan edges; expands declared records only — never sibling inject.
 * Does not materialize or write the store (install owns store soft links).
 */
export function buildInstallViewEdges(edges: ScanEdge[], storeRoot: string): ViewEdge[] {
    const seeds = collectSeedPackages(edges, storeRoot);
    const out: ViewEdge[] = [];
    const seenPkg = new Set<string>();
    // Dedup link targets: parentId\0depName
    const seenLink = new Set<string>();
    const queue: Array<{ name: string; version: string; dir: string }> = [...seeds];

    while (queue.length > 0) {
        const pkg = queue.shift()!;
        const id = `${pkg.name}@${pkg.version}`;
        if (seenPkg.has(id)) continue;
        seenPkg.add(id);

        const manifest = readPkgJsonFull(pkg.dir);
        if (!manifest) continue;

        const declared = collectDeclaredDeps(manifest);
        for (const dep of declared) {
            // Prefer install-owned links under parent/node_modules — never
            // retarget to a newer store match of the same range.
            const depDir = resolveStorePackage(storeRoot, dep.name, dep.range, pkg.dir);
            if (!depDir) {
                if (dep.optional) continue;
                // Required dep missing from store: emit a view edge that will
                // fail closed at link time (depDir empty → error).
                const linkKey = `${id}\0${dep.name}`;
                if (seenLink.has(linkKey)) continue;
                seenLink.add(linkKey);
                out.push({
                    parentName: pkg.name,
                    parentVersion: pkg.version,
                    depName: dep.name,
                    depDir: '',
                    optional: false,
                });
                continue;
            }
            const cv = packageIdFromDir(storeRoot, depDir, dep.name);
            if (!cv) continue;
            if (cv.name === pkg.name && cv.version === pkg.version) continue;

            const linkKey = `${id}\0${dep.name}`;
            if (seenLink.has(linkKey)) continue;
            seenLink.add(linkKey);

            out.push({
                parentName: pkg.name,
                parentVersion: pkg.version,
                depName: dep.name,
                depDir,
                optional: dep.optional,
            });

            const childId = `${cv.name}@${cv.version}`;
            if (!seenPkg.has(childId)) {
                queue.push({ name: cv.name, version: cv.version, dir: depDir });
            }
        }
    }

    return out;
}

function collectSeedPackages(
    edges: ScanEdge[],
    storeRoot: string,
): Array<{ name: string; version: string; dir: string }> {
    const map = new Map<string, { name: string; version: string; dir: string }>();
    const add = (name: string, version: string) => {
        const key = `${name}@${version}`;
        if (map.has(key)) return;
        const dir = joinPaths(storeRoot, `${name}@${version}`);
        if (!fs.exists(joinPaths(dir, 'package.json'))) return;
        map.set(key, { name, version, dir });
    };

    for (const edge of edges) {
        if (edge.parentSpecPath.startsWith('npm:')) {
            const pv = npmNameVersion(edge.parentSpecPath);
            if (pv) add(pv.name, pv.version);
        }
        const cv = npmNameVersion(edge.childSpecPath);
        if (cv) add(cv.name, cv.version);
    }
    return [...map.values()];
}

interface DeclaredDep {
    name: string;
    range: string;
    optional: boolean;
}

function collectDeclaredDeps(pkg: {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}): DeclaredDep[] {
    const out: DeclaredDep[] = [];
    const index = new Map<string, number>();
    // prefer: optionalDependencies overrides dependencies (npm semantics).
    const push = (name: string, range: string, optional: boolean, prefer = false) => {
        if (!name) return;
        const i = index.get(name);
        if (i !== undefined) {
            if (prefer) out[i] = { name, range: range || '*', optional };
            return;
        }
        index.set(name, out.length);
        out.push({ name, range: range || '*', optional });
    };

    const deps = pkg.dependencies;
    if (deps) {
        for (const name in deps) push(name, deps[name] ?? '*', false);
    }
    const peers = pkg.peerDependencies;
    const meta = pkg.peerDependenciesMeta;
    if (peers) {
        for (const name in peers) {
            const optional = meta?.[name]?.optional === true;
            push(name, peers[name] ?? '*', optional);
        }
    }
    const opt = pkg.optionalDependencies;
    if (opt) {
        for (const name in opt) push(name, opt[name] ?? '*', true, true);
    }
    return out;
}

/**
 * Resolve name@range against the flat store (`<store>/<name>@<ver>`).
 * When `parentDir` is set, an install-owned link at
 * `parentDir/node_modules/<name>` wins if its version still satisfies `range`
 * — materialize must not rewrite install targets to a newer store match.
 */
export function resolveStorePackage(
    storeRoot: string,
    name: string,
    range: string,
    parentDir?: string,
): string | null {
    const norm = stripLeadingV(range.trim());
    const opaque = isOpaqueDepRange(norm || '');

    if (parentDir) {
        const existing = readExistingDepTarget(parentDir, name);
        if (existing && packageSatisfiesRange(existing, norm || '*')) {
            return existing;
        }
    }

    // github:/tarball pins are not store-selectable by semver or bare alias.
    // Without an install-owned parent link, materialize fail-closes (empty depDir).
    if (opaque) return null;

    if (norm && isExactVersion(norm)) {
        const dir = joinPaths(storeRoot, `${name}@${norm}`);
        if (pkgJsonExists(dir)) return dir;
    }

    // Semver ranges must not pick URL/github store keys (`1.2.3+u` + 8 hex).
    const versions = listStoreVersions(storeRoot, name).filter(v => !isUrlTaggedStoreVersion(v));
    if (versions.length > 0) {
        const matched = matchLatestVersion(versions, norm || '*')
            ?? (versions.includes(norm) ? norm : null);
        if (matched) {
            const dir = joinPaths(storeRoot, `${name}@${matched}`);
            if (pkgJsonExists(dir)) return dir;
        }
    }

    // Alias symlink/dir: <store>/<name>
    const alias = joinPaths(storeRoot, name);
    if (pkgJsonExists(alias)) {
        try {
            return fs.realpath(alias);
        } catch {
            return alias;
        }
    }
    return null;
}

/** Absolute store (or package) dir currently linked as parent/node_modules/name. */
function readExistingDepTarget(parentDir: string, depName: string): string | null {
    const target = joinPaths(parentDir, 'node_modules', depName);
    let st: ReturnType<typeof fs.lstat> | null = null;
    try {
        st = fs.lstat(target);
    } catch {
        return null;
    }
    if (!st) return null;
    try {
        if (st.isSymbolicLink) {
            const linked = fs.readlink(target);
            // Prefer realpath so alias/relative links normalize to store path.
            try {
                const real = fs.realpath(target);
                if (pkgJsonExists(real)) return real;
            } catch {}
            if (pkgJsonExists(linked)) return linked;
            return null;
        }
        if (st.isDirectory && pkgJsonExists(target)) {
            try {
                return fs.realpath(target);
            } catch {
                return target;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function packageSatisfiesRange(pkgDir: string, range: string): boolean {
    const r = stripLeadingV(range.trim()) || '*';
    // github:/tarball pins are install-owned. Trust a linked package.json here;
    // resolveStorePackage never picks opaque deps via store alias/semver alone.
    if (isOpaqueDepRange(r)) return pkgJsonExists(pkgDir);
    const pkg = readPkgJsonFull(pkgDir);
    const ver = pkg?.version != null ? String(pkg.version) : null;
    if (!ver) return false;
    if (isExactVersion(r)) return ver === r || ver === stripLeadingV(r);
    // matchLatestVersion([ver], range) === ver ⇔ satisfies
    return matchLatestVersion([ver], r) === ver || ver === r;
}

/** Same class of ranges as npm isOpaqueVersionRange (no semver match). */
function isOpaqueDepRange(range: string): boolean {
    if (/^https?:\/\//i.test(range) || range.startsWith('github:')) return true;
    if (/^(?:git\+)?https:\/\/github\.com\//i.test(range)) return true;
    return false;
}

function listStoreVersions(storeRoot: string, name: string): string[] {
    const versions: string[] = [];
    try {
        if (name.startsWith('@')) {
            const slash = name.indexOf('/');
            if (slash <= 0) return versions;
            const scope = name.slice(0, slash);
            const leaf = name.slice(slash + 1);
            const scopeDir = joinPaths(storeRoot, scope);
            for (const entry of fs.readdir(scopeDir)) {
                const ver = versionFromScopedEntry(leaf, entry);
                if (ver) versions.push(ver);
            }
        } else {
            const prefix = `${name}@`;
            for (const entry of fs.readdir(storeRoot)) {
                if (entry.startsWith(prefix)) {
                    const ver = entry.slice(prefix.length);
                    if (ver && !ver.includes('/')) versions.push(ver);
                }
            }
        }
    } catch {
        // store root missing or unreadable
    }
    return versions;
}

function versionFromScopedEntry(leaf: string, entry: string): string | null {
    // entry is "parser@7.29.7" under @babel/
    const prefix = `${leaf}@`;
    if (!entry.startsWith(prefix)) return null;
    const ver = entry.slice(prefix.length);
    return ver || null;
}

function packageIdFromDir(
    storeRoot: string,
    depDir: string,
    fallbackName: string,
): { name: string; version: string } | null {
    // Prefer store path identity — URL-tagged dirs keep `+u…` (package.json does not).
    const normStore = storeRoot.endsWith('/') ? storeRoot.slice(0, -1) : storeRoot;
    const normDir = depDir.endsWith('/') ? depDir.slice(0, -1) : depDir;
    if (normDir.startsWith(normStore + '/')) {
        const rel = normDir.slice(normStore.length + 1);
        const at = rel.startsWith('@') ? rel.indexOf('@', 1) : rel.indexOf('@');
        if (at > 0) {
            return { name: rel.slice(0, at), version: rel.slice(at + 1) };
        }
    }
    const pkg = readPkgJsonFull(depDir);
    if (pkg?.name && pkg.version) {
        return { name: pkg.name, version: String(pkg.version) };
    }
    if (fallbackName) {
        return { name: fallbackName, version: '0.0.0' };
    }
    return null;
}

function pkgJsonExists(dir: string): boolean {
    try {
        return fs.exists(joinPaths(dir, 'package.json'));
    } catch {
        return false;
    }
}

function stripLeadingV(range: string): string {
    if (range.length > 1 && (range[0] === 'v' || range[0] === 'V') && range[1]! >= '0' && range[1]! <= '9') {
        return range.slice(1);
    }
    return range;
}

/** URL/github store keys (`1.2.3+u` + 8 hex) — not valid for semver range picks. */
function isUrlTaggedStoreVersion(ver: string): boolean {
    const i = ver.lastIndexOf('+u');
    if (i < 0) return false;
    const tag = ver.slice(i + 2);
    if (tag.length !== 8) return false;
    for (let j = 0; j < 8; j++) {
        const c = tag.charCodeAt(j);
        if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
    }
    return true;
}

function isExactVersion(range: string): boolean {
    // plain x.y.z with optional prerelease/build — no range operators
    if (/[<>*=|^~\s]/.test(range)) return false;
    return /^\d+\.\d+\.\d+/.test(range);
}

/** Symlink each root package's bin entries into <project>/node_modules/.bin. */
function materializeProjectBins(
    rootEdges: ScanEdge[],
    storeRoot: string,
    projectDir: string,
): void {
    const binDir = joinPaths(projectDir, 'node_modules', '.bin');
    for (const edge of rootEdges) {
        const cv = npmNameVersion(edge.childSpecPath);
        if (!cv) continue;
        const pkgDir = joinPaths(storeRoot, `${cv.name}@${cv.version}`);
        const pkg = readPkgJson(pkgDir);
        if (!pkg) continue;
        const binMap = getBinMap(pkg);
        for (const binName in binMap) {
            const rel = binMap[binName];
            if (!rel) continue;
            const source = joinPaths(pkgDir, rel);
            const target = joinPaths(binDir, binName);
            try {
                if (!fs.exists(source)) continue;
                let same = false;
                try {
                    same = fs.realpath(target) === fs.realpath(source);
                } catch {
                    same = false;
                }
                if (same) continue;
                // Stale/wrong bin from a prior root version — replace soft links.
                try {
                    const st = fs.lstat(target);
                    if (st.isSymbolicLink || !st.isDirectory) fs.unlink(target);
                } catch {}
                if (fs.exists(target)) continue;
                ensureDir(binDir);
                // Project .bin entries are files (Windows needs type=file).
                if (isWindows) fs.symlink(source, target, 'file');
                else fs.symlink(source, target);
                try { fs.chmod(source, 0o755); } catch {}
            } catch {
                // Best-effort: missing bin must not fail the whole materialize.
            }
        }
    }
}

function readPkgJson(dir: string): PackageJson | null {
    try {
        const raw = readText(joinPaths(dir, 'package.json'));
        return safeParse(raw);
    } catch {
        return null;
    }
}

function readPkgJsonFull(dir: string): {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    bin?: unknown;
} | null {
    try {
        const raw = readText(joinPaths(dir, 'package.json'));
        return safeParse(raw);
    } catch {
        return null;
    }
}

function edgeNames(edges: ScanEdge[]): string[] {
    const names = new Array<string>(edges.length);
    for (let i = 0; i < edges.length; i++) {
        names[i] = edges[i]?.name ?? '';
    }
    return names;
}

function resolveRootTargetDir(edge: ScanEdge, projectDir: string): string | null {
    if (edge.parentSpecPath.startsWith('npm:')) return null;
    return joinPaths(projectDir, 'node_modules', edge.name);
}

function canLinkRootEdge(edge: ScanEdge, storeRoot: string, projectDir: string): boolean {
    return !!resolveRootTargetDir(edge, projectDir) && !!npmNameVersion(edge.childSpecPath);
}

/** Soft: project root → store package (store itself is never written). */
async function linkProjectRootSoft(
    edge: ScanEdge,
    storeRoot: string,
    projectDir: string,
): Promise<void> {
    const targetDir = resolveRootTargetDir(edge, projectDir);
    const cv = npmNameVersion(edge.childSpecPath);
    if (!targetDir || !cv) return;
    const linkSource = joinPaths(storeRoot, `${cv.name}@${cv.version}`);
    try {
        if (!fs.exists(joinPaths(linkSource, 'package.json'))) {
            throw new Error(`store package missing: ${linkSource}`);
        }
        await placeSoftLink(linkSource, targetDir);
    } catch (e) {
        throw new Error(`failed to link ${edge.name} into ${targetDir}: ${errMsg(e)}`, { cause: e });
    }
}

async function placeSoftLink(linkSource: string, targetDir: string): Promise<void> {
    ensureDir(dirname(targetDir));
    let existing: ReturnType<typeof fs.lstat> | null = null;
    try {
        existing = fs.lstat(targetDir);
    } catch {}
    if (existing) {
        if (existing.isSymbolicLink) {
            try {
                if (fs.readlink(targetDir) === linkSource) return;
            } catch {}
            try {
                if (fs.realpath(targetDir) === fs.realpath(linkSource)) return;
            } catch {}
        }
        removeExisting(targetDir, existing);
    }
    if (isWindows) await asyncfs.symlink(linkSource, targetDir, asyncfs.FS_SYMLINK_JUNCTION);
    else fs.symlink(linkSource, targetDir);
}

function partitionRootEdges(edges: ScanEdge[]): { rootEdges: ScanEdge[] } {
    const root = new Map<string, ScanEdge>();
    for (const edge of edges) {
        if (edge.parentSpecPath.startsWith('npm:')) continue;
        root.set(`root:${edge.name}`, edge);
    }
    return { rootEdges: [...root.values()] };
}

function resetProjectRoots(projectDir: string, rootEdges: ScanEdge[]): void {
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
