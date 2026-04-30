// utils/progress.ts — multi-item parallel download progress
//
// Writes directly to stdout fd=1 using TTY.writeSync() so we can use \r
// to overwrite the same lines without console.log adding newlines.
// Falls back to plain console.log if not a TTY.

import { engine, timers, os, fs, pty, console } from './index';
const { setInterval, clearInterval } = timers;

// ---------------------------------------------------------------------------
// Color constants for better UI
// ---------------------------------------------------------------------------

const C = {
    red: (s: string) => isatty ? `\x1b[31m${s}\x1b[0m` : s,
    green: (s: string) => isatty ? `\x1b[32m${s}\x1b[0m` : s,
};

// ---------------------------------------------------------------------------
// TTY write helper
// ---------------------------------------------------------------------------

let isatty = false;
let termWidth = 80;

function initTty(): void {
    // Use os.guessHandle like in main.ts to detect TTY
    isatty = os.guessHandle(os.STDOUT_FILENO) === 'tty';
    if (isatty) {
        try {
            const winSize = pty.getwinsize(os.STDOUT_FILENO);
            termWidth = winSize.cols || 80;
        } catch {
            termWidth = 80;
        }
    }
}

function write(s: string): void {
    const buffer = engine.encodeString(s);
    fs.write(os.STDOUT_FILENO, buffer);
}

// ---------------------------------------------------------------------------
// Spinner frames
// ---------------------------------------------------------------------------

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------------------------------------------------------------------------
// MultiProgress — N concurrent download slots shown on screen
// ---------------------------------------------------------------------------

export interface ProgressItem {
    label: string;      // URL or short name
    total: number;      // bytes, 0 if unknown
    done: number;       // bytes received so far
    finished: boolean;
    error?: string;
}

export class MultiProgress {
    private items = new Map<string, ProgressItem>(); // key → item
    private order: string[] = [];
    private tick = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private completed = 0;
    private total = 0;
    private startMs = Date.now();

    constructor(private readonly maxLines = 5) {
        initTty();
        console.log(`[DEBUG MultiProgress] created, isatty: ${isatty}`);
    }

    add(key: string, label: string, totalBytes = 0): void {
        if (this.items.has(key)) return;
        const item: ProgressItem = { label, total: totalBytes, done: 0, finished: false };
        this.items.set(key, item);
        this.order.push(key);
        this.total++;
        if (!this.timer) this.startRender();
    }
    update(key: string, done: number, total = 0): void {
        const item = this.items.get(key);
        if (!item || item.finished) return;
        item.done = done;
        if (total) item.total = total;
    }

    finish(key: string, error?: string): void {
        const item = this.items.get(key);
        if (!item || item.finished) return;
        item.finished = true;
        item.error = error;
        this.completed++;
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (!isatty) {
            const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
            const e = this.items.size - this.completed;
            if (e > 0) {
                write(`${this.completed}/${this.total} modules done, ${e} failed  ${elapsed}s\n`);
            }
            return;
        }
        const drawn = (this as any)._lastLines as number | undefined;
        if (drawn) this.clearLines(drawn);
        const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
        const failed = this.items.size - this.completed;
        if (failed > 0) {
            write(`${this.completed}/${this.total} modules done, ${failed} failed  ${elapsed}s\n`);
        } else {
            write(`${this.completed}/${this.total} modules  ${elapsed}s\n`);
        }
        (this as any)._lastLines = 0;
    }

    private startRender(): void {
        if (!isatty) return;
        this.timer = setInterval(() => this.render(), 200);
    }

    private clearLines(n: number): void {
        // Move up n lines and clear each
        for (let i = 0; i < n; i++) write('\x1b[1A\x1b[2K');
    }

    private render(): void {
        if (!isatty) return;
        this.tick = (this.tick + 1) % SPINNER.length;
        const spin = SPINNER[this.tick]!;

        // Show at most maxLines active items (prioritise in-progress)
        const active = this.order.filter(k => !this.items.get(k)!.finished);
        const finished = this.order.filter(k => this.items.get(k)!.finished);
        const visible = [...active.slice(0, this.maxLines - 1), ...finished.slice(-1)];

        const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(1);
        const summary = `${spin} Precaching dependencies: ${this.completed}/${this.total} modules (${elapsed}s)`;
        const lines = [summary];

        for (const key of visible.slice(0, this.maxLines)) {
            const item = this.items.get(key)!;
            const short = truncate(item.label, termWidth - 25);
            if (item.error) {
                lines.push(`  ${C.red('✗')} ${short}`);
            } else if (item.finished) {
                lines.push(`  ${C.green('✓')} ${short}`);
            } else {
                const bar = item.total ? renderBar(item.done, item.total, 10) : 'waiting...';
                const bytes = fmtBytes(item.done);
                lines.push(`  ${spin} ${short} ${bar} ${bytes}`);
            }
        }

        // Overwrite previous render: clear as many lines as we last drew
        if ((this as any)._lastLines) {
            this.clearLines((this as any)._lastLines);
        }
        write(lines.join('\n') + '\n');
        (this as any)._lastLines = lines.length;
    }
}

// ---------------------------------------------------------------------------
// Simple single-line progress bar (used outside MultiProgress)
// ---------------------------------------------------------------------------

export class LineProgress {
    private startMs = Date.now();
    constructor(private readonly label: string) {
        initTty();
    }
    update(done: number, total: number): void {
        if (!isatty) return;
        const bar = total ? renderBar(done, total, 20) : '';
        const pct = total ? `${Math.floor(done / total * 100)}%` : fmtBytes(done);
        const s = `\r  ${this.label} ${bar} ${pct}`;
        write(truncate(s, termWidth));
    }
    stop(): void {
        if (isatty) write('\n');
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderBar(done: number, total: number, width: number): string {
    const pct = Math.min(1, done / total);
    const filled = Math.floor(pct * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
