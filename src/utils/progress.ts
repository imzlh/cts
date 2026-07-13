import { fmtBytes } from './misc';


const os = import.meta.use('os');
const engine = import.meta.use('engine');
const fs = import.meta.use('fs');
const { setInterval, clearInterval } = import.meta.use('timers');

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
    dim:    (s: string) => isatty ? `\x1b[2m${s}\x1b[0m`  : s,
    bold:   (s: string) => isatty ? `\x1b[1m${s}\x1b[0m`  : s,
    green:  (s: string) => isatty ? `\x1b[32m${s}\x1b[0m` : s,
    yellow: (s: string) => isatty ? `\x1b[33m${s}\x1b[0m` : s,
    cyan:   (s: string) => isatty ? `\x1b[36m${s}\x1b[0m` : s,
    red:    (s: string) => isatty ? `\x1b[31m${s}\x1b[0m` : s,
    blue:   (s: string) => isatty ? `\x1b[34m${s}\x1b[0m` : s,
};

// ---------------------------------------------------------------------------
// TTY
// ---------------------------------------------------------------------------

function getEnv(name: string): string | null {
    try {
        return os.getenv(name) ?? null;
    } catch {
        return null;
    }
}

export const isatty = (() => {
    try {
        return os.guessHandle(os.STDOUT_FILENO) === 'tty';
    } catch {
        return false;
    }
})();
let termWidth = (() => {
    const cols = Number(getEnv('COLUMNS') ?? '');
    return Number.isFinite(cols) && cols > 20 ? cols : 80;
})();

function write(s: string): void {
    fs.write(os.STDOUT_FILENO, engine.encodeString(s));
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------------------------------------------------------------------------
// PrecacheProgress — one object for the entire precache lifecycle
// ---------------------------------------------------------------------------

const BIG_THRESHOLD = 100 * 1024;

interface DownloadItem {
    label: string;
    total: number;
    done: number;
    finished: boolean;
    downloaded: boolean;
    error?: string;
    /** Wall-clock start for stall visibility (resolve/scan may never download). */
    startedMs: number;
}

export class PrecacheProgress {
    // Global counters
    private resolved    = 0;
    private downloaded  = 0;
    private linked      = 0;
    private linkTotal   = 0;
    private compiled    = 0;
    private compileTotal = 0;

    // Active big downloads (for detail lines)
    private items  = new Map<string, DownloadItem>();
    private activeOrder: string[] = [];
    private lastFinished: DownloadItem | null = null;
    private itemDone = 0;
    private itemTotal = 0;

    // Speed estimation
    private lastBytes    = 0;
    private lastBytesMs  = Date.now();
    private speed        = 0;

    // Render
    private tick  = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private drawn = 0;
    private startMs = Date.now();

    readonly maxLines: number;
    private readonly title: string;

    constructor(maxLines = 5, title = 'Precaching') {
        this.maxLines = maxLines;
        this.title = title;
    }

    // ---- Scan phase ----

    /** One specifier resolved (cached or downloaded). */
    bumpResolved(n = 1): void {
        this.resolved += n;
        this.kick();
    }

    /** Show that a specifier is actively being resolved, even before network starts. */
    startResolve(spec: string): void {
        this.addItem(spec, `resolve ${short(spec)}`, 0, false);
    }

    /** Build onProgress callback for a specifier. */
    onDownloadProgress(spec: string): (now: number, total: number) => void {
        return (now: number, total: number) => {
            const item = this.items.get(spec);
            if (!item) {
                this.addItem(spec, `fetch ${short(spec)}`, total, true);
            } else {
                item.label = `fetch ${short(spec)}`;
                item.downloaded = true;
            }
            this.updateItem(spec, now, total);
        };
    }

    /** A tracked (big) download finished. */
    finishDownload(key: string, error?: string): void {
        const item = this.items.get(key);
        if (!item || item.finished) return;
        item.finished = true;
        item.error = error;
        this.itemDone++;
        if (item.downloaded) this.downloaded++;
        this.removeActive(key);
        this.lastFinished = item;
        this.items.delete(key);
        this.kick();
    }

    // ---- Precompile phase ----

    setLinkProgress(done: number, total: number): void {
        this.linked = done;
        this.linkTotal = total;
        this.kick();
    }

    setCompileProgress(done: number, total: number): void {
        this.compiled = done;
        this.compileTotal = total;
        this.kick();
    }

    // ---- Lifecycle ----

    stop(): void {
        // stop() is terminal. Late producer callbacks during shutdown must not
        // recreate the interval and keep the process event loop alive.
        this.stopped = true;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (isatty && this.drawn) this.clearLines(this.drawn);
        this.drawn = 0;
    }

    clearForOutput(): void {
        if (isatty && this.drawn) this.clearLines(this.drawn);
        this.drawn = 0;
    }

    // ---- Internals ----

    private kick(): void {
        if (this.stopped) return;
        if (isatty && this.timer === null) {
            this.timer = setInterval(() => this.render(), 200);
            this.render();
        }
    }

    private addItem(key: string, label: string, totalBytes: number, downloaded: boolean): void {
        if (this.items.has(key)) return;
        this.items.set(key, {
            label,
            total: totalBytes,
            done: 0,
            finished: false,
            downloaded,
            startedMs: Date.now(),
        });
        this.activeOrder.push(key);
        this.itemTotal++;
        this.kick();
    }

    private removeActive(key: string): void {
        const index = this.activeOrder.indexOf(key);
        if (index !== -1) this.activeOrder.splice(index, 1);
    }

    private updateItem(key: string, done: number, total: number): void {
        const item = this.items.get(key);
        if (!item || item.finished) return;
        item.done = done;
        if (total) item.total = total;
        const now = Date.now();
        const dt = now - this.lastBytesMs;
        if (dt > 500) {
            let allDone = 0;
            for (const v of this.items.values()) if (!v.finished) allDone += v.done;
            this.speed = Math.max(0, (allDone - this.lastBytes) / (dt / 1000));
            this.lastBytes = allDone;
            this.lastBytesMs = now;
        }
    }

    private clearLines(n: number): void {
        for (let i = 0; i < n; i++) write('\x1b[1A\x1b[2K');
    }

    private render(): void {
        if (!isatty) return;
        this.tick = (this.tick + 1) % SPIN.length;
        const spin = SPIN[this.tick] ?? SPIN[0] ?? '';

        const elapsed = (Date.now() - this.startMs) / 1000;
        const elapsedStr = elapsed < 10 ? elapsed.toFixed(1) : String(Math.floor(elapsed));

        // Summary line
        const parts: string[] = [];
        parts.push(`${C.cyan('resolved')} ${C.bold(String(this.resolved))}`);
        if (this.downloaded > 0)
            parts.push(`${C.yellow('downloaded')} ${C.bold(String(this.downloaded))}`);
        if (this.linkTotal > 0)
            parts.push(`${C.green('linked')} ${C.bold(`${this.linked}/${this.linkTotal}`)}`);
        if (this.compileTotal > 0)
            parts.push(`${C.blue('compiled')} ${C.bold(`${this.compiled}/${this.compileTotal}`)}`);
        if (this.speed > 1024)
            parts.push(C.dim(`${fmtBytes(this.speed)}/s`));

        const lines = [`${spin} ${C.bold(this.title)}: ${parts.join(', ')} ${C.dim(`${elapsedStr}s`)}`];

        // Oldest in-flight first so a stuck resolve is always visible (not buried).
        const now = Date.now();
        const active: Array<{ key: string; item: DownloadItem; age: number }> = [];
        for (const key of this.activeOrder) {
            const item = this.items.get(key);
            if (!item || item.finished) continue;
            active.push({ key, item, age: now - item.startedMs });
        }
        active.sort((a, b) => b.age - a.age);

        const activeLimit = this.lastFinished ? this.maxLines - 1 : this.maxLines;
        for (let i = 0; i < active.length && i < activeLimit; i++) {
            const { item, age } = active[i]!;
            const ageStr = age >= 2000 ? C.yellow(` ${Math.floor(age / 1000)}s`) : '';
            const lbl = truncate(item.label, termWidth - 36);
            const bar = item.total ? renderBar(item.done, item.total, 12) : '';
            const pct = item.total ? ` ${Math.floor(item.done / item.total * 100)}%` : '';
            const size = item.downloaded ? ` ${C.dim(fmtBytes(item.done))}` : '';
            lines.push(`  ${C.cyan(spin)} ${lbl}${ageStr} ${C.green(bar)}${pct}${size}`);
        }
        if (this.lastFinished && lines.length <= this.maxLines) {
            const item = this.lastFinished;
            const lbl = truncate(item.label, termWidth - 30);
            if (item.error) lines.push(`  ${C.red('✗')} ${lbl} ${C.red(item.error)}`);
            else lines.push(`  ${C.green('✓')} ${lbl} ${item.total ? C.dim(fmtBytes(item.total)) : ''}`);
        }

        if (this.drawn) this.clearLines(this.drawn);
        write(lines.join('\n') + '\n');
        this.drawn = lines.length;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderBar(done: number, total: number, width: number): string {
    const filled = Math.floor(Math.min(1, done / total) * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function short(s: string): string {
    return s.length <= 55 ? s : '…' + s.slice(-54);
}
