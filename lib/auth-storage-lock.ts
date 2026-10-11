import { authNavigatorLock } from '@/lib/auth-lock'

/** Serialize synchronous session writes, including password login outside the SDK lock. */
export function createAuthStorageLock(key: string) {
    let opening: Promise<IDBDatabase> | null = null
    const database = () => {
        opening ??= new Promise<IDBDatabase>((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('Your browser cannot safely save this session.'))
                return
            }
            let expired = false
            const timer = setTimeout(() => {
                expired = true
                reject(new Error('Session storage is busy. Please retry.'))
            }, 10_000)
            const request = indexedDB.open(`pancake-auth-storage:${key}`, 1)
            request.onupgradeneeded = () => request.result.createObjectStore('lock')
            request.onerror = () => { clearTimeout(timer); reject(request.error) }
            request.onsuccess = () => {
                clearTimeout(timer)
                const db = request.result
                if (expired) { db.close(); return }
                db.onversionchange = () => { db.close(); opening = null }
                resolve(db)
            }
        }).catch((error) => { opening = null; throw error })
        return opening
    }
    return async <T>(work: () => T): Promise<T> => {
        if (typeof navigator !== 'undefined' && navigator.locks) {
            return authNavigatorLock(`pancake-session-write:${key}`, 10_000, async () => work())
        }
        const db = await database()
        return new Promise<T>((resolve, reject) => {
            const tx = db.transaction('lock', 'readwrite')
            const timer = setTimeout(() => tx.abort(), 10_000)
            let result: T
            let failure: unknown
            tx.oncomplete = () => { clearTimeout(timer); resolve(result) }
            tx.onabort = tx.onerror = () => {
                clearTimeout(timer)
                reject(failure ?? tx.error ?? new Error('Session storage is busy. Please retry.'))
            }
            // A queued transaction has not acquired its lock until this request runs.
            tx.objectStore('lock').get('barrier').onsuccess = () => {
                try { result = work() }
                catch (error) { failure = error; tx.abort() }
            }
        })
    }
}
