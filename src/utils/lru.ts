// utils/lru.ts — bounded LRU cache (Map-based, O(1) get/set)
//
// Used by pkg.ts and io.ts to cap memory usage of module resolution caches.
// JS Map preserves insertion order, so we use it as a queue:
//   - on get: delete + re-insert to move to back (most-recently-used)
//   - on set: evict front (least-recently-used) when over capacity

export class LRU<K, V> {
    private readonly map: Map<K, V>;

    constructor(private readonly cap: number) {
        this.map = new Map();
    }

    get(key: K): V | undefined {
        const v = this.map.get(key);
        if (v === undefined) return undefined;
        // Move to back (MRU)
        this.map.delete(key);
        this.map.set(key, v);
        return v;
    }

    /** Returns true if key existed. */
    has(key: K): boolean { return this.map.has(key); }

    set(key: K, value: V): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        // Evict LRU entry if over capacity
        if (this.map.size > this.cap) {
            const oldest = this.map.keys().next().value as K;
            this.map.delete(oldest);
        }
    }

    delete(key: K): void { this.map.delete(key); }
    clear(): void        { this.map.clear(); }
    get size(): number   { return this.map.size; }
}
