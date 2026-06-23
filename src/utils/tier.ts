// utils/tier.ts — lightweight OS memory tier detection for cts
//
// Standalone copy of the tier thresholds from cno/src/utils/memory-tier.ts
// because cts is a separate workspace package with no dependency on cno.
// Only tier classification — no buffer limits (those live in cno).

const os = import.meta.use('os');

export type MemoryTier = 'low' | 'normal' | 'high';

const LOW_MAX  = 128 * 1024 * 1024;   // 128 MB
const HIGH_MIN = 1024 * 1024 * 1024;  // 1 GB

let _tier: MemoryTier | null = null;

export function getMemoryTier(): MemoryTier {
    if (_tier !== null) return _tier;
    let totalBytes: number;
    try {
        totalBytes = os.memoryUsage()['os.total'] ?? 0;
    } catch {
        totalBytes = 256 * 1024 * 1024; // assume NORMAL on failure
    }
    if (totalBytes > 0 && totalBytes <= LOW_MAX) _tier = 'low';
    else if (totalBytes > HIGH_MIN)               _tier = 'high';
    else                                          _tier = 'normal';
    return _tier;
}
