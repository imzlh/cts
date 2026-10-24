/** Strip `sourceMappingURL` annotations from source destined for a .jspack.
 *
 *  An inline map leaks build-machine absolute paths and the pre-build original
 *  (base64, so a grep does not see it), and can never resolve inside a pack.
 *  Both forms and both syntaxes are removed; line structure is preserved so
 *  stack-trace line numbers do not shift. See cts/docs/pack-format.md.
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
