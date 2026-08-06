/** Strip `sourceMappingURL` annotations from source destined for a .jspack.
 *
 *  Why a pack must not carry them:
 *
 *  A dist file built with `--sourcemap=inline` ends in
 *  `//# sourceMappingURL=data:application/json;base64,…`. That payload is a
 *  complete source map: `sourceRoot` and `sources` hold the BUILD MACHINE's
 *  absolute paths, and `sourcesContent` holds the full pre-build original —
 *  including comments the author stripped from the shipped output on purpose.
 *  `cno pack` embeds source verbatim, so all of it shipped inside every
 *  artifact, and because it is base64 a plain grep of the .jspack for the
 *  leaked path returns NOTHING. That is why it went unnoticed: the artifact
 *  reads clean unless you decode first.
 *
 *  The goal is deliberately NOT "protect the source". A .jspack never hides
 *  source: plaintext ships beside the bytecode as the ABI fallback, and QuickJS
 *  retains the CJS wrapper's function source inside the bytecode as well, so a
 *  CJS module's text ships twice no matter what. The achievable goal is not
 *  leaking build-machine paths and pre-build comments the author never intended
 *  to publish — and that the annotation is the only part of the file whose
 *  removal costs nothing, because a source map can never resolve inside a pack
 *  anyway: `sources` names paths that do not exist on the consumer's machine,
 *  and an external `app.js.map` is not among the packed modules.
 *
 *  Both forms are removed for that reason (inline `data:` and external file
 *  reference), and both comment syntaxes, with the legacy `@` pragma as well as
 *  `#`. Line structure is preserved so line numbers in the remaining source —
 *  which is what stack traces resolve against once the map is gone — do not
 *  shift.
 */

/** Anchored to line start: per the source-map spec the annotation occupies its
 *  own line, so anchoring avoids rewriting a string literal or a comment that
 *  merely mentions `sourceMappingURL`. */
const LINE_COMMENT = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\n\r]*/gm;
const BLOCK_COMMENT = /^[ \t]*\/\*[#@][ \t]*sourceMappingURL=[\s\S]*?\*\/[ \t]*/gm;

export interface StripResult {
    text: string;
    /** Number of annotations removed; 0 means the text was already clean. */
    removed: number;
}

export function stripSourceMappingURL(text: string): StripResult {
    // Cheap reject: the overwhelming majority of modules have no annotation, and
    // this runs once per source module on the pack path.
    if (text.indexOf('sourceMappingURL') === -1) return { text, removed: 0 };

    let removed = 0;
    const out = text
        .replace(BLOCK_COMMENT, () => { removed++; return ''; })
        .replace(LINE_COMMENT, () => { removed++; return ''; });
    return { text: out, removed };
}

/** True when `text` still carries an annotation. Used by tests to assert the
 *  strip actually fired, and cheap enough to assert with. */
export function hasSourceMappingURL(text: string): boolean {
    if (text.indexOf('sourceMappingURL') === -1) return false;
    LINE_COMMENT.lastIndex = 0;
    BLOCK_COMMENT.lastIndex = 0;
    return LINE_COMMENT.test(text) || BLOCK_COMMENT.test(text);
}
