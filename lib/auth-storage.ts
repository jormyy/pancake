type StoredValue = { value: string | null; available: boolean }

// Supabase calls these methods after its initial storage support check. Each
// operation must handle a browser that later denies access or reaches quota.
export function createAuthStorage(getStorage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null) {
    const blocked = new Set<string>()
    const checked = new Set<string>()
    const read = (key: string): StoredValue => {
        if (blocked.has(key)) return { value: null, available: false }
        try {
            const storage = getStorage()
            if (!storage) return { value: null, available: false }
            const value = storage.getItem(key)
            if (value !== null && !checked.has(key)) {
                // A read-only store cannot remember logout. Check once per
                // document before trusting a saved identity across a restart.
                const probe = `${key}-storage-check`
                storage.setItem(probe, '')
                storage.removeItem(probe)
                checked.add(key)
            }
            return { value, available: true }
        } catch {
            return { value: null, available: false }
        }
    }
    return {
        read,
        getItem: (key: string) => read(key).value,
        setItem: (key: string, value: string) => {
            try {
                const storage = getStorage()
                if (!storage) { blocked.add(key); return }
                storage.setItem(key, value)
                blocked.delete(key)
            } catch {
                // An older on-disk identity must not stand in for a failed save.
                blocked.add(key)
                try { getStorage()?.removeItem(key) } catch { /* unavailable */ }
            }
        },
        removeItem: (key: string) => {
            try {
                const storage = getStorage()
                if (!storage) { blocked.add(key); return }
                storage.removeItem(key)
                blocked.delete(key)
            } catch {
                blocked.add(key)
                // Some policies deny removal but still permit overwriting. A
                // tombstone keeps the old session out of the next page too.
                try { getStorage()?.setItem(key, '') } catch { /* unavailable */ }
            }
        },
    }
}
