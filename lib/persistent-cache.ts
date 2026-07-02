import { Platform } from 'react-native'

type CacheEnvelope<T> = {
    version: 1
    savedAt: number
    value: T
}

const memoryCache = new Map<string, unknown>()

function localStorageForCache(): Storage | null {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null
    try {
        return window.localStorage
    } catch {
        return null
    }
}

export function readPersistentCache<T>(key: string): T | null {
    const storage = localStorageForCache()
    if (!storage) return (memoryCache.get(key) as T | undefined) ?? null

    try {
        const raw = storage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw) as CacheEnvelope<T>
        return parsed.version === 1 ? parsed.value : null
    } catch {
        return null
    }
}

export function writePersistentCache<T>(key: string, value: T): void {
    memoryCache.set(key, value)
    const storage = localStorageForCache()
    if (!storage) return

    try {
        const envelope: CacheEnvelope<T> = { version: 1, savedAt: Date.now(), value }
        storage.setItem(key, JSON.stringify(envelope))
    } catch {
        // Storage quota/private-mode failures should never block rendering.
    }
}

export function removePersistentCache(key: string): void {
    memoryCache.delete(key)
    const storage = localStorageForCache()
    if (!storage) return

    try {
        storage.removeItem(key)
    } catch {
        // Best effort only.
    }
}
