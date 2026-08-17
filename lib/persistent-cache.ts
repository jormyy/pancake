import { Platform } from 'react-native'

type CacheEnvelope<T> = {
    version: 1
    savedAt: number
    value: T
}

type CacheReadOptions = { maxAgeMs?: number }

const CACHE_PREFIX = 'pancake:'
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 64
const PREFIX_LIMITS = [
    ['pancake:player-search:', 12],
    ['pancake:dynasty-rankings:', 8],
    ['pancake:dynasty-decisions:', 16],
    ['pancake:dynasty-decisions-latest:', 8],
    ['pancake:dynasty-analyzer-snapshot:', 4],
    ['pancake:dynasty-analyzer-latest:', 4],
    ['pancake:player-screen:', 12],
    ['pancake:player-support:', 4],
    ['pancake:home-matchup:', 4],
] as const

const memoryCache = new Map<string, CacheEnvelope<unknown>>()

function localStorageForCache(): Storage | null {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function isFresh(savedAt: number, maxAgeMs: number): boolean {
    return Number.isFinite(savedAt) && Date.now() - savedAt <= maxAgeMs
}

function removeStorageKey(storage: Storage | null, key: string): void {
    memoryCache.delete(key)
    savedAtIndex.delete(key)
    if (!storage) return
    try {
        storage.removeItem(key)
    } catch {
        // Best effort only.
    }
}

function cacheKeys(storage: Storage): string[] {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key?.startsWith(CACHE_PREFIX)) keys.push(key)
    }
    return keys
}

// savedAt per key, kept in memory so pruning doesn't have to JSON.parse every
// stored envelope on each write (writes happen on hot interaction paths).
const savedAtIndex = new Map<string, number>()

function envelopeSavedAt(storage: Storage, key: string): number {
    const indexed = savedAtIndex.get(key)
    if (indexed !== undefined) return indexed
    try {
        const parsed = JSON.parse(storage.getItem(key) ?? '') as Partial<CacheEnvelope<unknown>>
        const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0
        savedAtIndex.set(key, savedAt)
        return savedAt
    } catch {
        savedAtIndex.set(key, 0)
        return 0
    }
}

function pruneStorage(storage: Storage): void {
    const byOldest = (a: string, b: string) => envelopeSavedAt(storage, a) - envelopeSavedAt(storage, b)
    const keys = cacheKeys(storage)
    for (const [prefix, limit] of PREFIX_LIMITS) {
        const matching = keys.filter((key) => key.startsWith(prefix)).sort(byOldest)
        for (const key of matching.slice(0, Math.max(0, matching.length - limit))) removeStorageKey(storage, key)
    }
    const remaining = cacheKeys(storage).sort(byOldest)
    for (const key of remaining.slice(0, Math.max(0, remaining.length - MAX_CACHE_ENTRIES))) {
        removeStorageKey(storage, key)
    }
}

function pruneMemoryCache(): void {
    const sorted = [...memoryCache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)
    for (const [prefix, limit] of PREFIX_LIMITS) {
        const matching = sorted.filter(([key]) => key.startsWith(prefix))
        for (const [key] of matching.slice(0, Math.max(0, matching.length - limit))) memoryCache.delete(key)
    }
    const remaining = [...memoryCache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)
    for (const [key] of remaining.slice(0, Math.max(0, remaining.length - MAX_CACHE_ENTRIES))) {
        memoryCache.delete(key)
    }
}

export function readPersistentCache<T>(key: string, options: CacheReadOptions = {}): T | null {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    const storage = localStorageForCache()
    if (!storage) {
        const cached = memoryCache.get(key) as CacheEnvelope<T> | undefined
        if (!cached) return null
        if (cached.version === 1 && isFresh(cached.savedAt, maxAgeMs)) return cached.value
        memoryCache.delete(key)
        return null
    }

    try {
        const raw = storage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw) as CacheEnvelope<T>
        if (parsed.version === 1 && isFresh(parsed.savedAt, maxAgeMs)) return parsed.value
        removeStorageKey(storage, key)
        return null
    } catch {
        removeStorageKey(storage, key)
        return null
    }
}

export function writePersistentCache<T>(key: string, value: T): void {
    const envelope: CacheEnvelope<T> = { version: 1, savedAt: Date.now(), value }
    memoryCache.set(key, envelope)
    pruneMemoryCache()
    const storage = localStorageForCache()
    if (!storage) return

    try {
        storage.setItem(key, JSON.stringify(envelope))
        savedAtIndex.set(key, envelope.savedAt)
        pruneStorage(storage)
    } catch {
        // A quota failure can be recoverable after evicting the oldest entry.
        try {
            const oldest = cacheKeys(storage).sort(
                (a, b) => envelopeSavedAt(storage, a) - envelopeSavedAt(storage, b),
            )[0]
            if (oldest) removeStorageKey(storage, oldest)
            storage.setItem(key, JSON.stringify(envelope))
            savedAtIndex.set(key, envelope.savedAt)
        } catch {
            // Storage/private-mode failures should never block rendering.
        }
    }
}

export function removePersistentCache(key: string): void {
    const storage = localStorageForCache()
    removeStorageKey(storage, key)
}

export function clearPersistentCaches(): void {
    memoryCache.clear()
    savedAtIndex.clear()
    const storage = localStorageForCache()
    if (!storage) return
    try {
        for (const key of cacheKeys(storage)) storage.removeItem(key)
    } catch {
        // Best effort only.
    }
}
