# .jspack container format

Maintainer reference for `cts/src/pack/format.ts`. The writer is
`cts/src/pack/writer.ts`; loading is `cts/src/pack/session.ts` and
`cts/src/resolve/protocols/pack.ts`.

## Layout (current version 4)

```text
offset  size  field
0       4     magic "JSPK"
4       2     u16 LE version
6       4     u32 LE manifest length
10      32    sha256 of the manifest bytes
42      N     manifest JSON (UTF-8)
42+N    M     blob
```

All integers are little-endian. `HEADER_LEN` is 42. The manifest digest covers
the manifest bytes exactly as serialized, which is why it lives in the
fixed-width header, outside its own coverage. `MAX_MANIFEST_LEN` is 64 MiB.

The blob is everything after the manifest. Its length is implicit, so the
manifest carries `blobLength` to make truncation and tail-extension detectable
(per-range bounds checks cannot see either).

## Manifest

```ts
{
  entry: string,                       // specPath of the entry module
  modules: Record<string, Entry>,      // specPath -> entry
  edges: Record<string, Record<string, string>>,
                                       // parent -> raw import specifier -> child
  bytecodeVersion: string,             // QuickJS bytecode ABI
  blobLength: number                   // declared blob byte length
}
```

### Module entry

| Field | Type | Meaning |
| --- | --- | --- |
| `localPath` | string | Synthetic runtime id (`pack:/<rel>` or `pack:<scheme>/…`); equals the modules key. Also the `PackBlobStore`/loader key. Not a host filesystem path. |
| `format` | `esm` \| `cjs` | |
| `fileKind` | `source` \| `json` \| `wasm` \| `binary` \| `text` | |
| `offset`, `length` | number | Blob range of the embedded bytes: bytecode for a source module, the payload otherwise. |
| `sourceOffset`, `sourceLength` | number | Original source range. Mandatory for `source`, forbidden otherwise. |
| `sourceOnly` | boolean | Recompile from bundled source even if bytecode exists (serialized bytecode lost required semantics). Only valid with `fileKind: "source"`. |
| `lang` | string | Explicit source language. Only valid with `fileKind: "source"`. |
| `digest` | hex string | Lowercase-hex sha256 of the embedded bytes at `offset+length`. |
| `sourceDigest` | hex string | Lowercase-hex sha256 of the embedded bytes at `sourceOffset+sourceLength`. `source` only. |

`digest` is not the hash of the file on disk. A source module's embedded bytes
have had `sourceMappingURL` stripped on the way into the blob (see
`cts/src/pack/sourcemap.ts`), so the two differ whenever a module carried an
annotation. The writer keeps a separate on-disk digest for its
"source changed while packing" check.

## Digests and verification

- Digests are computed over the bytes actually embedded
  (`completePackManifest` at encode time, `verifyRange` at read time).
- Verification is lazy and once per container (`verifiedRanges` WeakMap, keyed
  on the container so entry objects shared between containers cannot
  cross-credit). Hashing the whole blob eagerly would make startup pay for
  modules that are never loaded.
- A missing digest is a hard failure (`requireDigests` on decode), never a skip.
- A digest supplied on entry is verified, not trusted. Calling
  `completePackManifest` twice is safe.

## Versioning and superseded versions

Versions 1–3 had no integrity digests. They are refused rather than accepted
with a warning: the version field is attacker-controlled, so accepting an old
version would let a tamperer flip the version byte (and drop the digest field)
to skip every check — the same shape as JWT `"alg":"none"`. Packs are
regenerable build artifacts, so the cost of refusing is one `cno pack`.

`bytecodeVersion` is not a security control. It only selects bytecode-vs-recompile;
a tamperer sets it correctly so their bytecode runs. The digests are the
integrity mechanism.

## Validation rules (`validateManifest`)

Order matters: `encodePackHeader` validates shape and bounds before digesting so
that an out-of-bounds range is reported as a range error, not a digest error.

- Manifest is an object; `entry` is a string starting with `pack:` and without
  `\0`; `bytecodeVersion` is a non-empty string.
- `modules` and `edges` are objects.
- `blobLength` is a non-negative safe integer and equals the bytes actually
  present after the manifest.
- Every module id starts with `pack:` and contains no `\0`;
  `localPath === id`; `format` and `fileKind` are in the allowed sets.
- `offset`/`length` are in bounds: non-negative safe integers with
  `offset <= blobLength - length`.
- `source` entries have `sourceOffset`/`sourceLength`, in bounds. The pair is
  mandatory rather than just bounds-checked because `validRange` passes on
  `undefined`; the final `PackManifest` cast promises both fields.
- Non-source entries carry no `sourceOffset`, `sourceLength`, `sourceOnly`,
  `lang`, or `sourceDigest`.
- Digests, when present, are exactly 64 lowercase hex chars. On decode,
  `digest` (and `sourceDigest` for source entries) must be present.
- `sourceOnly` is a boolean; `sourceOnly: true` requires `fileKind: "source"`;
  `lang` is a non-empty string.
- `entry` is a key of `modules`.
- Every edge parent is a module; every bucket is an object; every specifier is
  non-empty without `\0`; every target is a module.

## Blob layout invariant (`validateBlobLayout`)

Declared ranges must be either byte-identical (dedup: two ids may share one
file) or completely disjoint; partial overlap and nesting are rejected.
`BlobBuilder` only appends whole buffers and dedupes by local path, so neither
can come out of the writer.

A source module's bytecode range must be unique (a fresh append per module id,
compiled under that id, which is baked into the atom table as the eval filename)
and must never alias another module's bytecode or any embedded source range.
Aliasing is the attack: point a clean module's bytecode at another module's
bytecode and the runtime runs the other body under the clean id with no
diagnostic. Bytecode is not self-describing enough to catch that later.

Zero-length ranges are ignored (they address no bytes).

## Duplicate keys

`assertNoDuplicateKeys` scans the raw manifest text before `JSON.parse` rejects
a key repeated inside any one object. JSON keeps the last occurrence, so the
file would run differently than it reads. The digest does not help — it covers
these exact bytes, so duplicates hash faithfully.

## Id canonicalization

Module ids and edge parents are rewritten with `canonicalizePath`
(`\` -> `/`) before validation. `ModuleResolver` canonicalizes specifiers before
looking pack ids up, so a `\` id (Windows-produced or hand-crafted) would be
unreachable and surface as `ModuleNotFound` blamed on static analysis. Two ids
that collapse to the same canonical form are rejected.

Edge specifier keys are raw import strings and stay verbatim; a non-matching
one fails closed with a message naming it. `encodePack` stays a faithful
serializer so callers can build exact fixtures.

## Reading

- `readBlob` / `readSourceBlob` re-check bounds (`subarray` clamps silently)
  and then verify the digest.
- `encodePackHeader` serializes header + manifest and returns the bytes that
  precede the blob; `encodePack` concatenates it with a materialized blob.
- `PackBlobSource` is a random-access view so the writer can supply its
  streaming `BlobBuilder` instead of a flat buffer.
