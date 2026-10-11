type IntentReason = 'initial' | 'active' | 'disabled' | 'logout'
export type WebPushIntent = {
    revision: string
    ownerId: string | null
    allowed: boolean
    pushEnabled: boolean
    reason: IntentReason
    retiredEndpoint?: string
}
export type WebPushAuthority = {
    generation: number
    revocationCredential: string
    ownerId: string | null
}

const STORE = 'records'
const DATABASE = `pancake-web-push:${process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'default'}`
let opening: Promise<IDBDatabase> | null = null

function database(): Promise<IDBDatabase> {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('Notification storage is unavailable.'))
            return
        }
        const request = indexedDB.open(DATABASE, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(STORE)
        request.onerror = () => reject(request.error ?? new Error('Notification storage failed.'))
        request.onsuccess = () => {
            const db = request.result
            db.onversionchange = () => { db.close(); opening = null }
            resolve(db)
        }
    }).catch((error) => { opening = null; throw error })
    return opening
}

async function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const db = await database()
    return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        let result: T
        let completed = false
        tx.oncomplete = () => completed ? resolve(result) : reject(new Error('Notification storage did not complete.'))
        tx.onabort = () => reject(tx.error ?? new Error('Notification storage failed.'))
        tx.onerror = () => reject(tx.error ?? new Error('Notification storage failed.'))
        work(tx.objectStore(STORE), (value) => { result = value; completed = true })
    })
}

function initialIntent(): WebPushIntent {
    return { revision: crypto.randomUUID(), ownerId: null, allowed: false, pushEnabled: true, reason: 'initial' }
}

function readIntent(store: IDBObjectStore, consume: (intent: WebPushIntent) => void): void {
    const request = store.get('intent')
    request.onsuccess = () => consume(request.result ?? initialIntent())
}

function sameIntent(current: WebPushIntent, expected: WebPushIntent): boolean {
    return current.revision === expected.revision && current.ownerId === expected.ownerId && current.allowed
}

export function captureWebPushIntent(): Promise<WebPushIntent> {
    return transaction('readwrite', (store, done) => readIntent(store, (intent) => {
        store.put(intent, 'intent')
        done(intent)
    }))
}

export function admitWebPushIntent(previous: WebPushIntent, ownerId: string, action: 'login' | 'enable'): Promise<WebPushIntent | null> {
    return transaction('readwrite', (store, done) => readIntent(store, (current) => {
        if (current.revision !== previous.revision || (action === 'enable' && (
            current.reason === 'logout' || (current.ownerId !== null && current.ownerId !== ownerId)
        ))) { done(null); return }
        const enabled = action === 'enable' || current.pushEnabled
        const next: WebPushIntent = {
            revision: crypto.randomUUID(), ownerId, allowed: enabled, pushEnabled: enabled,
            reason: enabled ? 'active' : 'disabled',
            retiredEndpoint: current.retiredEndpoint,
        }
        store.put(next, 'intent')
        done(next)
    }))
}

export function closeWebPushIntent(ownerId: string | null, reason: 'logout' | 'disabled', expected: WebPushIntent, stillCurrent: () => boolean): Promise<WebPushIntent | null> {
    return transaction('readwrite', (store, done) => readIntent(store, (current) => {
        if (!stillCurrent() || current.revision !== expected.revision
            || (current.ownerId !== null && current.ownerId !== ownerId)) { done(null); return }
        const next: WebPushIntent = {
            revision: crypto.randomUUID(), ownerId: ownerId ?? current.ownerId, allowed: false,
            pushEnabled: reason === 'disabled' ? false : current.pushEnabled, reason,
            retiredEndpoint: current.retiredEndpoint,
        }
        store.put(next, 'intent')
        done(next)
    }))
}

export function retireWebPushEndpoint(intent: WebPushIntent, endpoint: string): Promise<boolean> {
    return transaction('readwrite', (store, done) => readIntent(store, (current) => {
        if (current.revision !== intent.revision || current.allowed) { done(false); return }
        store.put({ ...current, retiredEndpoint: endpoint }, 'intent')
        done(true)
    }))
}

export async function assertWebPushIntent(expected: WebPushIntent): Promise<void> {
    const matches = await transaction<boolean>('readonly', (store, done) => readIntent(store, (current) => done(sameIntent(current, expected))))
    if (!matches) throw new Error('Notification action changed. Sign in again or enable notifications again.')
}

function newAuthority(): WebPushAuthority {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { generation: 0, ownerId: null, revocationCredential: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') }
}

export function readWebPushAuthority(endpoint: string, intent: WebPushIntent, markPending = false): Promise<WebPushAuthority | null> {
    return transaction('readwrite', (store, done) => readIntent(store, (current) => {
        if (!sameIntent(current, intent)) { done(null); return }
        const key = `endpoint:${endpoint}`
        const request = store.get(key)
        request.onsuccess = () => {
            const authority: WebPushAuthority = request.result ?? newAuthority()
            if (!request.result || markPending) store.put({ ...authority, ownerId: null }, key)
            done(authority)
        }
    }))
}

export function saveWebPushAuthority(endpoint: string, authority: WebPushAuthority): Promise<void> {
    if (!Number.isSafeInteger(authority.generation) || authority.generation <= 0
        || !/^[A-Za-z0-9_-]{43}$/.test(authority.revocationCredential)) {
        return Promise.reject(new Error('Notification registration acknowledgement is invalid.'))
    }
    return transaction('readwrite', (store, done) => {
        const key = `endpoint:${endpoint}`
        const request = store.get(key)
        request.onsuccess = () => {
            const current: WebPushAuthority | undefined = request.result
            if (!current || current.generation < authority.generation) store.put(authority, key)
            else if (current.generation === authority.generation && current.revocationCredential !== authority.revocationCredential) {
                store.transaction.abort()
                return
            }
            done(undefined)
        }
    })
}
