import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '@supabase/supabase-js'
import { createAuthStorage } from '@/lib/auth-storage'
import { createAuthInvalidation } from '@/lib/auth-invalidation'
import { createAuthLogoutGuard } from '@/lib/auth-logout-guard'
import { authSession, fixtureProject } from '../helpers/auth-session'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const key = 'sb-auth-fixture-auth-token'
function store(values = new Map<string, string>()) {
    return createAuthStorage(() => ({ getItem: name => values.get(name) ?? null,
        setItem: (name, value) => { values.set(name, value) }, removeItem: name => { values.delete(name) } }))
}

describe('installed SDK overlapping startup and password login', () => {
    it.each([200, 400])('preserves B when A startup refresh returns %s after B signs in', async (status) => {
        vi.useFakeTimers()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const disk = new Map<string, string>()
        const A = { ...authSession('A', Math.floor(Date.now() / 1000) - 10), refresh_token: 'refresh-A' }
        const B = { ...authSession('B'), expires_in: 3600, refresh_token: 'refresh-B' }
        const refreshedA = { ...authSession('A'), expires_in: 3600, refresh_token: 'new-refresh-A' }
        disk.set(key, JSON.stringify(A))
        let release!: (response: Response) => void
        const firstResponse = new Promise<Response>(resolve => { release = resolve })
        let refreshRequests = 0
        const upstream = vi.fn<typeof fetch>(async (input) => {
            const url = new URL(String(input))
            if (url.searchParams.get('grant_type') === 'password') return new Response(JSON.stringify(B), { status: 200 })
            if (url.searchParams.get('grant_type') === 'refresh_token') {
                refreshRequests += 1
                return refreshRequests === 1 ? firstResponse : new Response(JSON.stringify(refreshedA), { status: 200 })
            }
            throw new Error('Unexpected fixture request')
        })
        const make = (autoRefreshToken: boolean) => {
            const invalidation = createAuthInvalidation(store(disk), store(), key, () => {})
            const guarded = createAuthLogoutGuard(invalidation, key, fixtureProject, async work => work())
            return new AuthClient({ url: fixtureProject + '/auth/v1',
                storage: guarded.sdkStorage, storageKey: key, persistSession: true, autoRefreshToken,
                detectSessionInUrl: false, lock: async (_name, _timeout, work) => work(),
                fetch: invalidation.fetch(upstream),
            })
        }
        const authA = make(true)
        const initialized = authA.initialize()
        await vi.advanceTimersByTimeAsync(0)
        expect(refreshRequests).toBe(1)
        const authB = make(false)
        try {
            const login = await authB.signInWithPassword({ email: 'B@example.test', password: 'synthetic-password' })
            expect(login.error).toBeNull()
            expect(JSON.parse(disk.get(key)!).user.id).toBe('B')
            release(new Response(JSON.stringify(status === 200 ? refreshedA : { msg: 'Refresh token revoked', error_code: 'refresh_token_not_found' }), { status }))
            // Exercise the real SDK retry loop, not only the first rejected response.
            await vi.advanceTimersByTimeAsync(35_000)
            await initialized
            expect(refreshRequests).toBe(1)
            expect(JSON.parse(disk.get(key)!).user.id).toBe('B')
            const recovered = await authA.getSession()
            expect(recovered.data.session?.user.id).toBe('B')
        } finally {
            await authA.stopAutoRefresh()
            await authB.stopAutoRefresh()
        }
    })
    it('can emit a late null event after authorized old cleanup and a newer password login', async () => {
        const disk = new Map([[key, '{"invalid":"old-A"}']])
        let release!: () => void
        let removed!: () => void
        const removedSignal = new Promise<void>(resolve => { removed = resolve })
        const releaseSignal = new Promise<void>(resolve => { release = resolve })
        const B = { ...authSession('B'), expires_in: 3600, refresh_token: 'refresh-B' }
        const events: { event: string; emittedOwner: string | null; storedOwner: string | null }[] = []
        const make = (holdRemoval: boolean) => {
            const invalidation = createAuthInvalidation(store(disk), store(), key, () => {})
            const guarded = createAuthLogoutGuard(invalidation, key, fixtureProject, async work => work())
            return new AuthClient({ url: fixtureProject + '/auth/v1', storageKey: key,
                storage: { ...guarded.sdkStorage, removeItem: async name => {
                    await guarded.sdkStorage.removeItem(name)
                    if (name === key && holdRemoval) { removed(); await releaseSignal }
                } }, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false,
                lock: async (_name, _timeout, work) => work(),
                fetch: invalidation.fetch(vi.fn<typeof fetch>(async () => new Response(JSON.stringify(B)))),
            })
        }
        const authA = make(true)
        const subscription = authA.onAuthStateChange((event, value) => {
            events.push({ event, emittedOwner: value?.user.id ?? null, storedOwner: JSON.parse(disk.get(key) ?? 'null')?.user?.id ?? null })
        }).data.subscription
        await removedSignal
        const authB = make(false)
        try {
            expect((await authB.signInWithPassword({ email: 'B@example.test', password: 'synthetic-password' })).error).toBeNull()
            release()
            await authA.initialize()
            expect(events).toContainEqual({ event: 'SIGNED_OUT', emittedOwner: null, storedOwner: 'B' })
            expect(JSON.parse(disk.get(key)!).user.id).toBe('B')
        } finally {
            release()
            subscription.unsubscribe()
            await authA.stopAutoRefresh()
            await authB.stopAutoRefresh()
        }
    })

})
