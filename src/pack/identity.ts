/** Synthetic pack:/… and attribute-view identities. */

import { moduleViewRef, type FileKind } from '../types';
import { guessFileKind } from '../resolve/protocols/base';

/** Same scheme rule as ModuleResolver's private protoOf — 2–8 lowercase alpha. */
export function specScheme(specPath: string): string | null {
    const ci = specPath.indexOf(':');
    if (ci < 2 || ci > 8) return null;
    const scheme = specPath.slice(0, ci);
    for (let i = 0; i < scheme.length; i++) {
        const c = scheme.charCodeAt(i);
        if (c < 97 || c > 122) return null;
    }
    return scheme;
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
