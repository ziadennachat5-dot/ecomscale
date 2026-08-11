/**
 * Global in-memory cache with TTL for Supabase query results.
 * Prevents duplicate fetches and provides instant data on tab switch.
 */

interface CacheEntry<T = unknown> {
    data: T;
    timestamp: number;
    ttl: number;
}

const store = new Map<string, CacheEntry>();

/** Default TTL: 60 seconds */
const DEFAULT_TTL = 60_000;

export function getCached<T>(key: string): T | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
        store.delete(key);
        return null;
    }
    return entry.data as T;
}

export function setCached<T>(key: string, data: T, ttl = DEFAULT_TTL): void {
    store.set(key, { data, timestamp: Date.now(), ttl });
}

export function invalidate(key: string): void {
    store.delete(key);
}

export function invalidatePrefix(prefix: string): void {
    for (const k of store.keys()) {
        if (k.startsWith(prefix)) store.delete(k);
    }
}

export function clearAll(): void {
    store.clear();
}
