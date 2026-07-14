import { fmtBytes } from './misc';

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const fs = import.meta.use('fs');
const { setInterval, clearInterval } = import.meta.use('timers');

const C = {
    dim:    (s: string) => isatty ? `\x1b[2m${s}\x1b[0m`  : s,
    bold:   (s: string) => isatty ? `\x1b[1m${s}\x1b[0m`  : s,
    green:  (s: string) => isatty ? `\x1b[32m${s}\x1b[0m` : s,
    yellow: (s: string) => isatty ? `\x1b[33m${s}\x1b[0m` : s,
    cyan:   (s: string) => isatty ? `\x1b[36m${s}\x1b[0m` : s,
    red:    (s: string) => isatty ? `\x1b[31m${s}\x1b[0m` : s,
    blue:   (s: string) => isatty ? `\x1b[34m${s}\x1b[0m` : s,
};

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

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PAINT_MS = 200;

/**
 * TTY progress for precache/pack.
 *
 * Ownership:
 * - Callers only mutate state (counters, activity, download rows).
 * - This class owns all paints via a private setInterval.
 * - Long sync work must yield the event loop elsewhere (`yieldEventLoop`)
 *   so the timer can fire — yielding is not a progress API.
 */
interface DownloadItem {
    label: string;
    total: number;
    done: number;
    finished: boolean;
    downloaded: boolean;
    error?: string;
    startedMs: number;
}

export class PrecacheProgress {
    private resolved    = 0;
    private downloaded  = 0;
    private linked      = 0;
    private linkTotal   = 0;
    private compiled    = 0;
    private compileTotal = 0;

    private items  = new Map<string, DownloadItem>();
    private activeOrder: string[] = [];
    private lastFinished: DownloadItem | null = null;
    private itemDone = 0;
    private itemTotal = 0;

    private lastBytes    = 0;
    private lastBytesMs  = Date.now();
    private speed        = 0;

    private tick  = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private drawn = 0;
    private startMs = Date.now();
    private activity: string | null = null;

    readonly maxLines: number;
    private readonly title: string;

    constructor(maxLines = 5, title = 'Precaching') {
        this.maxLines = maxLines;
        this.title = title;
        this.ensureTimer();
    }

    // ---- State only (never paint) ----

    bumpResolved(n = 1): void {
        this.resolved += n;
        this.ensureTimer();
    }

    setActivity(label: string | null): void {
        this.activity = label ? short(label) : null;
        this.ensureTimer();
    }

    startResolve(spec: string): void {
        this.addItem(spec, `resolve ${short(spec)}`, 0, false);
    }

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
            this.ensureTimer();
        };
    }

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
        this.ensureTimer();
    }

    setLinkProgress(done: number, total: number): void {
        this.linked = done;
        this.linkTotal = total;
        this.ensureTimer();
    }

    setCompileProgress(done: number, total: number): void {
        this.compiled = done;
        this.compileTotal = total;
        this.ensureTimer();
    }

    // ---- Lifecycle (may clear the TTY region) ----

    /** Hide spinner; later mutations re-arm the paint timer. */
    pause(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (isatty && this.drawn) this.clearLines(this.drawn);
        this.drawn = 0;
        // Drop scan/download rows so the next phase does not show stale ✓ lines.
        this.items.clear();
        this.activeOrder.length = 0;
        this.lastFinished = null;
        this.activity = null;
    }

    /** Terminal shutdown: no further paints. */
    stop(): void {
        this.stopped = true;
        this.pause();
    }

    /** Temporarily clear the spinner region so log lines can print. */
    clearForOutput(): void {
        if (isatty && this.drawn) this.clearLines(this.drawn);
        this.drawn = 0;
    }

    // ---- Internals ----

    private ensureTimer(): void {
        if (this.stopped || !isatty || this.timer !== null) return;
        this.timer = setInterval(() => this.render(), PAINT_MS);
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
        this.ensureTimer();
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
        if (!isatty || this.stopped) return;
        const now = Date.now();
        this.tick = (this.tick + 1) % SPIN.length;
        const spin = SPIN[this.tick] ?? SPIN[0] ?? '';

        const elapsed = (now - this.startMs) / 1000;
        const elapsedStr = elapsed < 10 ? elapsed.toFixed(1) : String(Math.floor(elapsed));

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

        if (this.activity) {
            lines.push(`  ${C.cyan(spin)} ${truncate(this.activity, termWidth - 8)}`);
        }

        const active: Array<{ key: string; item: DownloadItem; age: number }> = [];
        for (const key of this.activeOrder) {
            const item = this.items.get(key);
            if (!item || item.finished) continue;
            active.push({ key, item, age: now - item.startedMs });
        }
        active.sort((a, b) => b.age - a.age);

        let room = this.maxLines - (this.activity ? 1 : 0);
        if (this.lastFinished) room = Math.max(0, room - 1);
        for (let i = 0; i < active.length && i < room; i++) {
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
