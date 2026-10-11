import { inspectSession } from '@/lib/auth-session'
import { createAuthInvalidation } from '@/lib/auth-invalidation'

type AuthStorage = ReturnType<typeof createAuthInvalidation>

function sessionId(token: string): string | null {
    try {
        const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        const claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')))
        return typeof claims.session_id === 'string' && claims.session_id ? claims.session_id : null
    } catch { return null }
}

export function createAuthLogoutGuard(storage: AuthStorage, key: string, projectUrl: string, write: <T>(work: () => T) => Promise<T>) {
    let lastRead: ReturnType<typeof capture> | undefined
    const capture = () => {
        const raw = storage.read(key)
        let session = null
        try { session = inspectSession(JSON.parse(raw.value ?? 'null'), projectUrl).session }
        catch { /* Invalid stored data has no server revocation authority. */ }
        return { ...raw, revision: storage.current().id, session }
    }
    const matches = (expected: ReturnType<typeof capture>) => {
        const current = capture()
        if (current.revision !== expected.revision || current.available !== expected.available) return false
        if (current.value === expected.value) return true
        if (!current.session || !expected.session || current.session.user.id !== expected.session.user.id) return false
        const priorId = sessionId(expected.session.access_token)
        return priorId !== null && priorId === sessionId(current.session.access_token)
    }
    return {
        capture, matches,
        sdkStorage: {
            getItem: (name: string) => {
                if (name !== key) return storage.getItem(name)
                lastRead = capture()
                return lastRead.value
            },
            setItem: (name: string, value: string) => name === key
                ? write(() => storage.setItem(name, value)) : storage.setItem(name, value),
            removeItem: (name: string) => {
                if (name !== key) return storage.removeItem(name)
                const expected = lastRead
                return write(() => {
                    if (!expected || !matches(expected)) throw new Error('Your account changed. Please retry.')
                    storage.removeItem(name)
                })
            },
        },
    }
}
