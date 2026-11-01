/**
 * Bun builtin naming rules. Kept free of runtime imports so the resolver, the
 * CJS loader and the module bridge can share them without pulling in I/O.
 */

/** The only supported canonical Bun builtin identities. */
export const BUN_MODULES = ['bun', 'bun:sqlite'] as const;
export type BunModule = typeof BUN_MODULES[number];

/** Reserve the whole family, including unknown and malformed `bun:*` names. */
export function isBunSpecifier(spec: string): boolean {
    // URL schemes are case-insensitive; reserve `BUN:x` too so it cannot slip
    // past this guard into import maps or the generic scheme dispatcher.
    return spec === 'bun' || spec.slice(0, 4).toLowerCase() === 'bun:';
}

/** Exact canonical name, or null for anything else in the reserved family. */
export function canonicalBunSpecifier(spec: string): BunModule | null {
    return spec === 'bun' || spec === 'bun:sqlite' ? spec : null;
}

const PAYLOAD_VIEW_PREFIX = 'ctsview:bun-payload/';

/**
 * Runtime identity of the hidden module that holds a Bun payload's real
 * exports. It is not a `bun:*` name, never reaches import resolution, and is
 * answered by `ModuleResolver.getInfo` ahead of every protocol handler (a
 * pack's `ctsview:` handler only knows views of its own manifest modules).
 */
export function bunPayloadViewRef(name: BunModule): string {
    return PAYLOAD_VIEW_PREFIX + name;
}

/** Inverse of bunPayloadViewRef; null for any other specifier. */
export function bunPayloadViewName(ref: string): BunModule | null {
    return ref.startsWith(PAYLOAD_VIEW_PREFIX)
        ? canonicalBunSpecifier(ref.slice(PAYLOAD_VIEW_PREFIX.length))
        : null;
}
