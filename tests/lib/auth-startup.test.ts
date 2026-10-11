import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createAuthClientLock } from '@/lib/auth-lock'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function nativeLockControl() {
    let held = true
    const waiters: (() => void)[] = []
    const request = vi.fn((_name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
        if (!held) return Promise.resolve(callback({ name: _name, mode: 'exclusive' } as Lock))
        return new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException('Deadline', 'AbortError'))
            options.signal?.addEventListener('abort', abort, { once: true })
            waiters.push(() => {
                options.signal?.removeEventListener('abort', abort)
                if (!options.signal?.aborted) resolve(callback({ name: _name, mode: 'exclusive' } as Lock))
            })
        })
    })
    vi.stubGlobal('navigator', { locks: { request } })
    return { request, hold: () => { held = true }, release: () => { held = false; waiters.splice(0).forEach(fn => fn()) } }
}

function authClient() {
    return createClient('http://127.0.0.1:56481', 'unused-synthetic-test-key', {
        auth: { storageKey: `test-auth-${crypto.randomUUID()}`, autoRefreshToken: false,
            persistSession: false, detectSessionInUrl: false, lock: createAuthClientLock() },
    }).auth
}

describe('real SDK startup and auth lock interaction', () => {
    it('waits for the startup owner without poisoning later session reads', async () => {
        vi.useFakeTimers()
        const locks = nativeLockControl(), auth = authClient()
        let settled = false
        const session = auth.getSession().finally(() => { settled = true })
        const outcome = session.then(value => ({ value }), error => ({ error }))
        await vi.advanceTimersByTimeAsync(6000)
        expect(settled).toBe(false)
        expect(locks.request).toHaveBeenCalledOnce()
        expect(locks.request.mock.calls[0][1]).not.toHaveProperty('steal')
        locks.release()
        expect(await outcome).toEqual({ value: { data: { session: null }, error: null } })
        expect(await auth.getSession()).toEqual({ data: { session: null }, error: null })
        expect(await auth.signOut()).toEqual({ error: null })
    })

    it('retains the deadline after successful startup and recovers on the next read', async () => {
        vi.useFakeTimers()
        const locks = nativeLockControl()
        locks.release()
        const auth = authClient()
        expect(await auth.getSession()).toEqual({ data: { session: null }, error: null })
        locks.hold()
        const rejected = expect(auth.getSession()).rejects.toMatchObject({ isAcquireTimeout: true })
        await vi.advanceTimersByTimeAsync(5000)
        await rejected
        locks.release()
        expect(await auth.getSession()).toEqual({ data: { session: null }, error: null })
    })
})
