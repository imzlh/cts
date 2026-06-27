// progress.ts — unified precache progress UI
//
// PrecacheProgress spans the entire precache lifecycle (scan + precompile).
// DepScanner and PrecompileDriver call its methods; it owns all rendering.
//
// TTY:  live multi-line render with spinner, colors, speed
// pipe: per-download 📦 lines (from handlers via !isatty)

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

export const isatty = (() => {
    try { return os.guessHandle(os.STDOUT_FILENO) === 'tty'; }
    catch { return false; }
})();
let termWidth = (() => {
    try {
        const cols = Number(os.getenv('COLUMNS') ?? '');
        return Number.isFinite(cols) && cols > 20 ? cols : 80;
    } catch {
        return 80;
    }
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
}

export class PrecacheProgress {
    // Global counters
    private resolved    = 0;
    private downloaded  = 0;
    private compiled    = 0;
    private compileTotal = 0;

    // Active big downloads (for detail lines)
    private items  = new Map<string, DownloadItem>();
    private order  : string[] = [];
    private itemDone = 0;
    private itemTotal = 0;

    // Speed estimation
    private lastBytes    = 0;
    private lastBytesMs  = Date.now();
    private speed        = 0;

    // Render
    private tick  = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private drawn = 0;
    private startMs = Date.now();

    readonly maxLines: number;

    constructor(maxLines = 5) {
        this.maxLines = maxLines;
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
        this.kick();
    }

    // ---- Precompile phase ----

    setCompileProgress(done: number, total: number): void {
        this.compiled = done;
        this.compileTotal = total;
        this.kick();
    }

    // ---- Lifecycle ----

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (isatty && this.drawn) this.clearLines(this.drawn);
        this.drawn = 0;
    }

    // ---- Internals ----

    private kick(): void {
        if (isatty && !this.timer) {
            this.timer = setInterval(() => this.render(), 200);
            this.render();
        }
    }

    private addItem(key: string, label: string, totalBytes: number, downloaded: boolean): void {
        if (this.items.has(key)) return;
        this.items.set(key, { label, total: totalBytes, done: 0, finished: false, downloaded });
        this.order.push(key);
        this.itemTotal++;
        this.kick();
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
        const spin = SPIN[this.tick]!;

        const active  = this.order.filter(k => !this.items.get(k)!.finished);
        const finished = this.order.filter(k => this.items.get(k)!.finished);
        const visible = [...active.slice(0, this.maxLines - 1), ...finished.slice(-1)];

        const elapsed = (Date.now() - this.startMs) / 1000;
        const elapsedStr = elapsed < 10 ? elapsed.toFixed(1) : String(Math.floor(elapsed));

        // Summary line
        const parts: string[] = [];
        parts.push(`${C.cyan('resolved')} ${C.bold(String(this.resolved))}`);
        if (this.downloaded > 0)
            parts.push(`${C.yellow('downloaded')} ${C.bold(String(this.downloaded))}`);
        if (this.compileTotal > 0)
            parts.push(`${C.blue('compiled')} ${C.bold(`${this.compiled}/${this.compileTotal}`)}`);
        if (this.speed > 1024)
            parts.push(C.dim(`${fmtBytes(this.speed)}/s`));

        const lines = [`${spin} ${C.bold('Precaching')}: ${parts.join(', ')} ${C.dim(`${elapsedStr}s`)}`];

        // Detail lines (big downloads)
        for (const key of visible.slice(0, this.maxLines)) {
            const item = this.items.get(key)!;
            const lbl = truncate(item.label, termWidth - 30);
            if (item.error) {
                lines.push(`  ${C.red('✗')} ${lbl} ${C.red(item.error)}`);
            } else if (item.finished) {
                lines.push(`  ${C.green('✓')} ${lbl} ${item.total ? C.dim(fmtBytes(item.total)) : ''}`);
            } else {
                const bar = item.total ? renderBar(item.done, item.total, 12) : '';
                const pct = item.total ? ` ${Math.floor(item.done / item.total * 100)}%` : '';
                lines.push(`  ${C.cyan(spin)} ${lbl} ${C.green(bar)}${pct} ${C.dim(fmtBytes(item.done))}`);
            }
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
