/** Synthetic pack:/… and attribute-view identities. */

import { moduleViewRef, type FileKind } from '../types';
import { guessFileKind } from '../resolve/protocols/base';
import { schemeId } from '../utils/path';

/** Extract the normalized scheme from a module identity. */
export function specScheme(specPath: string): string | null {
    return schemeId(specPath);
}

/** Map import-attribute type onto a ctsview: identity when it differs from base. */
export function attributeViewId(
    id: string,
    baseKind: FileKind | ReturnType<typeof guessFileKind>,
    attr?: Record<string, unknown>,
): string {
    const type = attr?.type;
    const view: FileKind = type === 'text' ? 'text'
        : type === 'bytes' ? 'binary'
        : type === 'json' ? 'json'
        : baseKind as FileKind;
    return view === baseKind ? id : moduleViewRef(id, view);
}
