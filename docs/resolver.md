# Resolver internals

Maintainer reference for `cts/src/resolve/`. The pipeline is
`source key -> canonical specPath -> ModuleInfo` (see `docs/module-loading.md`
for the overview); this file records the invariants that are too detailed for
inline comments.

## npm version selection (`protocols/npm.ts`)

### Unconstrained ranges (`''` / `latest` / `*`)

Only the registry decides what "latest" means; a warm store hit alone is not an
answer (`isUnconstrainedRange`). Constrained ranges state their own intent and
keep the warm store fast path. When the registry is unreachable, the offline
fallback is tiered and purely local (safe under `--cached-only`):

1. `dist-tags.latest` / version match from cached metadata (any age; membership
   in `meta.versions` is immutable, so old metadata still attests a version).
2. Members of `meta.versions` found in the store; a `dist-tags.latest` that is
   not attested is ignored and a warning is emitted.
3. Highest store version with no metadata at all; a warning is always emitted
   (once per package, even under `--silent`).

URL/github store versions (`<ver>+u<hash>`) never count as attestation.
`findCachedPackageMatching(..., allowUnconstrainedStoreHit)` governs only the
unconstrained case: false at the version-resolution entry points, true for
peer/optional link-if-present paths.

### Other npm invariants

- `rejectVersionAfterSubpath` rewrites a misplaced version into an actionable
  suggestion; `isOpaqueVersionRange` keeps `https://…tgz` / `github:owner/repo`
  ranges from being split on `/`.
- Lock entries are prior resolved decisions and outrank dist-tags.
- `.meta/` (not `<cacheDir>/<name>`) holds registry metadata: the latter is an
  alias symlink target.
- Preparation is cycle-guarded by the call-stack `cyclePath` set only; prepare
  must never be coalesced under a FLOW key (FLOW_ALL of mutual deps would
  cross-await and hang).
- A package is marked prepared only after its dependency walk succeeds.

## Local node_modules lookup

`isDotNodeModulesSlot` only disqualifies a dotted slot dir itself
(`node_modules/.deno/vite@7.3.6`); the package body one level below owns its
files.

## Package format classification (`pkg.ts`)

A `.js` file with no manifest anywhere above it is CJS under `require()` and
ESM under `import`. When the walk finds no package.json or deno.json, caches
store the `'unresolved'` reason, not a format, so the answer stays
context-dependent and cannot be poisoned across callers.

The `.bin` symlink writer and lock bin index use `getBinMap()` (safe keys);
read-only lookups use `getLookupBinMap()` (arbitrary keys, containment enforced
on the target by `resolvePackageBinPath`).

## Resolution misses vs transport failures

Only "does not exist" (npm/jsr 404/410, missing local file) is a resolution
miss (`ErrorKind.ModuleNotFound` / `FileNotFound`, codes `MODULE_NOT_FOUND` /
`ENOENT`). 5xx/403/429/DNS/TLS failures stay `NetworkError` so the CJS
resolution walk cannot swallow them.

## Materialization (`linker.ts`)

`materializeNodeModules` never writes into the flat store (install owns
store-internal soft links). `hard` mode mirrors the store into
`node_modules/.cts/`; with `parentDir`, an existing install-owned link wins if
it still satisfies the range.

## Resolution misses

`isResolutionMiss` distinguishes a true miss (fall through to CJS local FS /
plain MODULE_NOT_FOUND) from policy or network errors, which must propagate.
`require.resolve()` goes through `resolveForInspection` (cached-only): its
store-miss error must be converted to a plain miss, never surfaced as a
`--cached-only` message.
