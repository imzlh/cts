export class LRU<K, V> {
    private readonly map: Map<K, V>;

    constructor(private readonly cap: number) {
        this.map = new Map();
    }

    get(key: K): V | undefined {
        const v = this.map.get(key);
        if (v === undefined) return undefined;
        this.map.delete(key);
        this.map.set(key, v);
        return v;
    }

    /** Returns true if key existed. */
    has(key: K): boolean { return this.map.has(key); }

    set(key: K, value: V): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.cap) {
            const oldest = this.map.keys().next();
            if (!oldest.done) this.map.delete(oldest.value);
        }
    }

    delete(key: K): void { this.map.delete(key); }
    clear(): void        { this.map.clear(); }
    get size(): number   { return this.map.size; }
}
