// utils/log.ts — structured debug logger
//
// Usage:
//   import { log } from './utils/log';
//   log.debug('resolver', () => `resolve "${spec}" from "${parent}"`);
//   log.warn('npm', 'metadata cache expired for', name);
//
// Enable via environment variable:
//   DEBUG=*              # all categories
//   DEBUG=resolver,npm   # specific categories
//   DEBUG=resolver,!lock # resolver but not lock
//
// Key design: the message lambda is ONLY called when the category is active.
// This avoids string interpolation cost on every hot-path call.

import { os, console } from './index';

// ---------------------------------------------------------------------------
// Category index
// ---------------------------------------------------------------------------

let initialised = false;
const enabled  = new Set<string>();   // active categories
const disabled = new Set<string>();   // explicitly disabled with !prefix

function init(): void {
    if (initialised) return;
    initialised = true;
    let raw = '';
    try { raw = os.getenv('DEBUG') ?? ''; } catch {}
    if (!raw) return;
    for (const tok of raw.split(',').map(s => s.trim()).filter(Boolean)) {
        if (tok.startsWith('!')) disabled.add(tok.slice(1));
        else enabled.add(tok);
    }
}

export function isEnabled(category: string): boolean {
    init();
    if (disabled.has(category)) return false;
    return enabled.has('*') || enabled.has(category);
}

// ---------------------------------------------------------------------------
// Logger API
// ---------------------------------------------------------------------------

type Lazy = () => string;
type Msg  = string | Lazy;

function resolve(msg: Msg): string {
    return typeof msg === 'function' ? msg() : msg;
}

export const log = {
    /**
     * Debug log — message is lazily evaluated, zero cost when disabled.
     * @param category  e.g. 'resolver', 'npm', 'jsr', 'loader', 'lock'
     * @param msg       string or () => string
     * @param rest      additional args (passed to console.log)
     */
    debug(category: string, msg: Msg, ...rest: any[]): void {
        if (!isEnabled(category)) return;
        console.log(`\x1b[2m[${category}]\x1b[0m ${resolve(msg)}`, ...rest);
    },

    /** Always shown regardless of DEBUG. */
    info(msg: string, ...rest: any[]): void {
        console.log(msg, ...rest);
    },

    warn(category: string, msg: Msg, ...rest: any[]): void {
        console.warn(`[${category}] ${resolve(msg)}`, ...rest);
    },

    error(category: string, msg: Msg, ...rest: any[]): void {
        console.error(`[${category}] ${resolve(msg)}`, ...rest);
    },
};
