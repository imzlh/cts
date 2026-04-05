/**
 * HTTP Progress Display
 * Provides graphical progress bar for slow network connections
 */

import { engine, timers, fs, os } from '../utils/index';

export interface ProgressOptions {
    total?: number;          // Total bytes expected (0 = unknown)
    width?: number;          // Progress bar width in characters
    showSpeed?: boolean;     // Show download speed
    showTime?: boolean;      // Show estimated time remaining
    updateInterval?: number; // Update interval in ms
    threshold?: number;      // Minimum file size to show progress bar (default: 32KB)
}

export class HttpProgressBar {
    private total: number;
    private width: number;
    private showSpeed: boolean;
    private showTime: boolean;
    private updateInterval: number;
    
    private loaded: number = 0;
    private startTime: number = Date.now();
    private lastUpdateTime: number = Date.now();
    private lastLoaded: number = 0;
    private timer: number | null = null;
    private active: boolean = false;
    private url: string = "";

    constructor(options: ProgressOptions = {}) {
        this.total = options.total || 0;
        this.width = options.width || 40;
        this.showSpeed = options.showSpeed !== false;
        this.showTime = options.showTime !== false;
        this.updateInterval = options.updateInterval || 500;
    }

    /**
     * Start progress tracking
     */
    start(url: string): void {
        this.url = url;
        this.loaded = 0;
        this.startTime = Date.now();
        this.lastUpdateTime = Date.now();
        this.lastLoaded = 0;
        this.active = true;
        
        // Clear any existing timer
        if (this.timer) {
            timers.clearInterval(this.timer);
        }
        
        // Set up update timer
        this.timer = timers.setInterval(() => {
            if (this.active) {
                this.render();
            }
        }, this.updateInterval);
        
        // Initial render
        this.render();
    }

    /**
     * Update progress with new data
     */
    update(bytesReceived: number): void {
        this.loaded = bytesReceived;
        if (!this.active) {
            this.active = true;
        }
    }

    /**
     * Complete the progress
     */
    complete(): void {
        this.active = false;
        if (this.timer) {
            timers.clearInterval(this.timer);
            this.timer = null;
        }
        
        // Final render with completion status
        this.render(true);
    }

    /**
     * Render the progress bar
     */
    private render(complete: boolean = false): void {
        const now = Date.now();
        const elapsed = (now - this.startTime) / 1000; // seconds
        
        // Calculate percentage if total is known
        let percent = 0;
        if (this.total > 0) {
            percent = Math.min(100, Math.round((this.loaded / this.total) * 100));
        }
        
        // Calculate speed
        const speed = this.calculateSpeed(now);
        
        // Calculate ETA if total is known
        let eta = "";
        if (this.total > 0 && this.loaded > 0 && speed > 0) {
            const remaining = this.total - this.loaded;
            const secondsLeft = Math.round(remaining / speed);
            eta = this.formatTime(secondsLeft);
        }
        
        // Build progress bar
        const filled = Math.round((this.width * percent) / 100);
        const empty = this.width - filled;
        const bar = "█".repeat(filled) + "░".repeat(empty);
        
        // Format sizes
        const loadedStr = this.formatSize(this.loaded);
        const totalStr = this.total > 0 ? this.formatSize(this.total) : "???";
        const speedStr = speed > 0 ? `${this.formatSize(speed)}/s` : "";
        
        // Build output
        let output = `\r[${bar}] ${loadedStr}/${totalStr}`;
        
        if (this.total > 0) {
            output += ` (${percent}%)`;
        }
        
        if (this.showSpeed && speedStr) {
            output += ` ${speedStr}`;
        }
        
        if (this.showTime && eta) {
            output += ` ETA: ${eta}`;
        }
        
        if (complete) {
            const totalTime = this.formatTime(elapsed);
            output = `\r[████████████████████████████████████████] ${loadedStr}/${totalStr} (100%) ${speedStr} Time: ${totalTime}\n`;
        }
        
        // Write to console
        const buffer = engine.encodeString(output);
        fs.write(os.STDOUT_FILENO, buffer);
    }

    /**
     * Calculate current download speed
     */
    private calculateSpeed(now: number): number {
        const timeDiff = (now - this.lastUpdateTime) / 1000; // seconds
        const bytesDiff = this.loaded - this.lastLoaded;
        
        if (timeDiff <= 0) {
            return 0;
        }
        
        // Update last values
        this.lastUpdateTime = now;
        this.lastLoaded = this.loaded;
        
        // Return bytes per second
        return bytesDiff / timeDiff;
    }

    /**
     * Format bytes to human readable size
     */
    private formatSize(bytes: number): string {
        const units = ["B", "KB", "MB", "GB"];
        let size = bytes;
        let unitIndex = 0;
        
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }
        
        return `${size.toFixed(1)}${units[unitIndex]}`;
    }

    /**
     * Format seconds to human readable time
     */
    private formatTime(seconds: number): string {
        if (seconds < 60) {
            return `${Math.round(seconds)}s`;
        } else if (seconds < 3600) {
            const mins = Math.floor(seconds / 60);
            const secs = Math.round(seconds % 60);
            return `${mins}m${secs}s`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const mins = Math.floor((seconds % 3600) / 60);
            return `${hours}h${mins}m`;
        }
    }
}

/**
 * Create a progress bar for HTTP downloads
 */
export function createProgressBar(options?: ProgressOptions): HttpProgressBar {
    return new HttpProgressBar(options);
}