import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearPersistentCaches, readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { setSessionOwner } from '@/lib/session-cache-registry'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

let entries: Map<string, string>
let storage: Storage
const key = 'pancake:test:storage'

beforeEach(() => {
    entries = new Map()
    storage = {
        get length() { return entries.size },
        key: index => [...entries.keys()][index] ?? null,
        getItem: entry => entries.get(entry) ?? null,
        setItem: (entry, value) => { entries.set(entry, value) },
        removeItem: entry => { entries.delete(entry) },
        clear: () => entries.clear(),
    }
    vi.stubGlobal('window', { localStorage: storage })
    setSessionOwner('owner')
    clearPersistentCaches()
})

afterEach(() => {
    clearPersistentCaches()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

it('keeps a successful storage write out of the memory fallback', () => {
    writePersistentCache(key, 'stored')
    expect(readPersistentCache(key)).toBe('stored')
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage unavailable') } })
    expect(readPersistentCache(key)).toBeNull()
})

it('removes stale storage and reads the memory fallback after both write attempts fail', () => {
    entries.set('pancake:test:oldest', JSON.stringify({ version: 1, savedAt: Date.now() - 1000, value: 'oldest' }))
    entries.set(key, JSON.stringify({ version: 1, savedAt: Date.now(), value: 'stale' }))
    const write = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    writePersistentCache(key, 'fresh')
    expect(write).toHaveBeenCalledTimes(2)
    expect(entries.has(key)).toBe(false)
    expect(readPersistentCache(key)).toBe('fresh')
})

it('retries storage after eviction without retaining a memory copy', () => {
    writePersistentCache('pancake:test:oldest', 'oldest')
    const write = vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Quota exceeded') })
    writePersistentCache(key, 'stored after retry')
    expect(write).toHaveBeenCalledTimes(2)
    expect(entries.has('pancake:test:oldest')).toBe(false)
    expect(readPersistentCache(key)).toBe('stored after retry')
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage unavailable') } })
    expect(readPersistentCache(key)).toBeNull()
})

it('discards an earlier memory fallback after storage recovers', () => {
    const write = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage denied') })
    writePersistentCache(key, 'memory only')
    expect(readPersistentCache(key)).toBe('memory only')
    write.mockRestore()
    writePersistentCache(key, 'stored')
    expect(readPersistentCache(key)).toBe('stored')
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage unavailable') } })
    expect(readPersistentCache(key)).toBeNull()
})

it('removes the memory fallback with its cache entry', async () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage denied') })
    writePersistentCache(key, 'memory only')
    const { removePersistentCache } = await import('@/lib/persistent-cache')
    removePersistentCache(key)
    expect(readPersistentCache(key)).toBeNull()
})
