const os = import.meta.use('os');
const console = import.meta.use('console');

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
    try {
        raw = os.getenv('DEBUG') ?? '';
    } catch {}
    if (!raw) return;
    let start = 0;
    for (let i = 0; i <= raw.length; i++) {
        if (i !== raw.length && raw.charCodeAt(i) !== 44) continue;
        let lo = start, hi = i;
        while (lo < hi && raw.charCodeAt(lo) <= 32) lo++;
        while (hi > lo && raw.charCodeAt(hi - 1) <= 32) hi--;
        if (lo < hi) {
            if (raw.charCodeAt(lo) === 33) disabled.add(raw.slice(lo + 1, hi));
            else enabled.add(raw.slice(lo, hi));
        }
        start = i + 1;
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
type ConsoleMethod = (...args: unknown[]) => void;
type ConsoleWithOriginals = typeof console & {
    __originals__?: Partial<Record<'log' | 'warn' | 'error', ConsoleMethod>>;
};

function resolve(msg: Msg): string {
    return typeof msg === 'function' ? msg() : msg;
}

// ---------------------------------------------------------------------------
// Native console access — bypass the JS hook installed by DebugSession.
// DebugSession.installConsoleHook saves the C-module originals on the console
// object as console.__originals__ BEFORE wrapping. We use those to avoid
// forwarding internal debug logs to DevTools.
// ---------------------------------------------------------------------------

function nativeLog(...args: unknown[]): void {
    const origs = (console as ConsoleWithOriginals).__originals__;
    const fn = origs?.log ?? console.log;
    fn.apply(console, args);
}
function nativeWarn(...args: unknown[]): void {
    const origs = (console as ConsoleWithOriginals).__originals__;
    const fn = origs?.warn ?? console.warn;
    fn.apply(console, args);
}
function nativeError(...args: unknown[]): void {
    const origs = (console as ConsoleWithOriginals).__originals__;
    const fn = origs?.error ?? console.error;
    fn.apply(console, args);
}

export const log = {
    /**
     * Debug log — message is lazily evaluated, zero cost when disabled.
     * @param category  e.g. 'resolver', 'npm', 'jsr', 'loader', 'lock'
     * @param msg       string or () => string
     * @param rest      additional args (passed to console.log)
     */
    debug(category: string, msg: Msg, ...rest: unknown[]): void {
        if (!isEnabled(category)) return;
        nativeLog(`\x1b[2m[${category}]\x1b[0m ${resolve(msg)}`, ...rest);
    },

    /** Always shown regardless of DEBUG. */
    info(msg: string, ...rest: unknown[]): void {
        nativeLog(msg, ...rest);
    },

    warn(category: string, msg: Msg, ...rest: unknown[]): void {
        nativeWarn(`[${category}] ${resolve(msg)}`, ...rest);
    },

    error(category: string, msg: Msg, ...rest: unknown[]): void {
        nativeError(`[${category}] ${resolve(msg)}`, ...rest);
    },

    download(url: string): void {
        nativeLog(`✨ ${url}...`);
    }
};
