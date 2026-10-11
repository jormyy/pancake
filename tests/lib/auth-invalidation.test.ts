import { describe, expect, it, vi } from 'vitest'
import { createAuthStorage } from '@/lib/auth-storage'
import { createAuthInvalidation } from '@/lib/auth-invalidation'

const key = 'sb-local-auth-token'
function store() {
    const values = new Map<string, string>()
    return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) }, removeItem: (k: string) => { values.delete(k) } }
}
function fixture() {
    const disk = store(), backup = store(), changed = vi.fn()
    disk.setItem(key, JSON.stringify({ access_token: 'old', refresh_token: 'refresh-original' }))
    const make = () => createAuthInvalidation(createAuthStorage(() => disk), createAuthStorage(() => backup), key, changed)
    return { disk, backup, changed, make, auth: make() }
}
async function response(auth: ReturnType<typeof createAuthInvalidation>, token: string, grant = 'password') {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ access_token: token })))
    await auth.fetch(fetcher)(`http://local/auth/v1/token?grant_type=${grant}`, { body: JSON.stringify({ refresh_token: 'refresh-original' }) })
}

describe('local auth invalidation', () => {
    it('clears own SDK keys, survives restart, and leaves other storage alone', () => {
        const { auth, disk, make, changed } = fixture()
        disk.setItem('other-project', 'keep')
        disk.setItem(`${key}-code-verifier`, 'own')
        auth.invalidate()
        expect(auth.getItem(key)).toBeNull()
        expect(make().getItem(key)).toBeNull()
        expect(disk.getItem(`${key}-code-verifier`)).toBeNull()
        expect(disk.getItem('other-project')).toBe('keep')
        expect(changed).toHaveBeenCalledOnce()
    })
    it('rejects stale SDK saves and refresh grants; only new password authentication can restore', async () => {
        const { auth } = fixture()
        await response(auth, 'late')
        auth.invalidate()
        expect(() => auth.setItem(key, JSON.stringify({ access_token: 'late' }))).toThrow('after local sign-out')
        await expect(response(auth, 'refresh', 'refresh_token')).rejects.toThrow('Authentication changed')
        await response(auth, 'new')
        auth.setItem(key, JSON.stringify({ access_token: 'new' }))
        expect(JSON.parse(auth.getItem(key)!)).toEqual({ access_token: 'new' })
        expect(() => auth.setItem(key, JSON.stringify({ access_token: 'old', refresh_token: 'refresh-original' }))).toThrow('after local sign-out')
    })
    it('fences a response whose body arrives after logout', async () => {
        const { auth } = fixture()
        let finish!: (response: Response) => void
        const pending = new Promise<Response>((resolve) => { finish = resolve })
        const request = auth.fetch(vi.fn<typeof fetch>().mockReturnValue(pending))('http://local/auth/v1/token?grant_type=password')
        auth.invalidate()
        finish(new Response(JSON.stringify({ access_token: 'late' })))
        await expect(request).rejects.toThrow('Authentication changed')
        expect(auth.getItem(key)).toBeNull()
    })
    it('drops a refresh that answers after another account signed in, whether it succeeded or failed', async () => {
        const { auth, disk } = fixture()
        disk.setItem(key, JSON.stringify({ access_token: 'a-access', refresh_token: 'a-refresh' }))
        let finish!: (response: Response) => void
        const pending = new Promise<Response>((resolve) => { finish = resolve })
        const refresh = auth.fetch(vi.fn<typeof fetch>().mockReturnValue(pending))(
            'http://local/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: 'a-refresh' }) })
        // Account B signs in on this device before A's refresh answers.
        await response(auth, 'b-access')
        auth.setItem(key, JSON.stringify({ access_token: 'b-access', refresh_token: 'b-refresh' }))
        finish(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
        await expect(refresh).rejects.toThrow('no longer holds')
        expect(JSON.parse(auth.getItem(key)!)).toEqual({ access_token: 'b-access', refresh_token: 'b-refresh' })

        const late = auth.fetch(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ access_token: 'a-late', refresh_token: 'a-next' }))))(
            'http://local/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: 'a-refresh' }) })
        await expect(late).rejects.toThrow('no longer holds')
    })
    it('passes a refresh for the session this device holds', async () => {
        const { auth, disk } = fixture()
        disk.setItem(key, JSON.stringify({ access_token: 'a-access', refresh_token: 'a-refresh' }))
        const result = await auth.fetch(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ access_token: 'a-next', refresh_token: 'a-refresh-2' }))))(
            'http://local/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: 'a-refresh' }) })
        expect(result.status).toBe(200)
        auth.setItem(key, JSON.stringify({ access_token: 'a-next', refresh_token: 'a-refresh-2' }))
        expect(JSON.parse(auth.getItem(key)!).access_token).toBe('a-next')
    })
    it('keeps a tombstone in session storage when local removal and writes fail', () => {
        const { auth, disk, make } = fixture()
        vi.spyOn(disk, 'setItem').mockImplementation(() => { throw new Error('denied') })
        vi.spyOn(disk, 'removeItem').mockImplementation(() => { throw new Error('denied') })
        auth.invalidate()
        vi.restoreAllMocks()
        expect(disk.getItem(key)).not.toBeNull()
        expect(make().getItem(key)).toBeNull()
    })
    it('keeps a later denied logout ahead of a previously saved login marker', async () => {
        const { auth, disk, make } = fixture()
        auth.invalidate()
        await response(auth, 'new')
        auth.setItem(key, JSON.stringify({ access_token: 'new' }))
        vi.spyOn(disk, 'setItem').mockImplementation(() => { throw new Error('denied') })
        vi.spyOn(disk, 'removeItem').mockImplementation(() => { throw new Error('denied') })
        auth.invalidate()
        expect(auth.getItem(key)).toBeNull()
        vi.restoreAllMocks()
        expect(make().getItem(key)).toBeNull()
    })
    it('shares logout across adapters and permits a later real login in the other tab', async () => {
        const { auth, make } = fixture(), tab = make()
        await response(tab, 'prior')
        auth.invalidate()
        expect(tab.getItem(key)).toBeNull()
        expect(() => tab.setItem(key, JSON.stringify({ access_token: 'prior' }))).toThrow()
        await response(tab, 'second')
        tab.setItem(key, JSON.stringify({ access_token: 'second' }))
        expect(auth.getItem(key)).toBe(tab.getItem(key))
    })
    it('rejects an old refresh response after another tab signs in without logout', async () => {
        const { auth, make } = fixture(), tab = make()
        let finish!: (value: Response) => void
        const pending = new Promise<Response>(resolve => { finish = resolve })
        const oldRefresh = auth.fetch(vi.fn<typeof fetch>().mockReturnValue(pending))('http://local/auth/v1/token?grant_type=refresh_token', { body: JSON.stringify({ refresh_token: 'refresh-original' }) })
        await response(tab, 'B')
        tab.setItem(key, JSON.stringify({ access_token: 'B' }))
        finish(new Response(JSON.stringify({ access_token: 'A-refreshed' })))
        await expect(oldRefresh).rejects.toThrow('Authentication changed')
        expect(JSON.parse(auth.getItem(key)!)).toEqual({ access_token: 'B' })
    })
    it('blocks retries with an old account refresh token before any HTTP request', async () => {
        const { auth, make } = fixture(), tab = make()
        await response(tab, 'B')
        tab.setItem(key, JSON.stringify({ access_token: 'B', refresh_token: 'refresh-B' }))
        const fetcher = vi.fn<typeof fetch>()
        await expect(auth.fetch(fetcher)('http://local/auth/v1/token?grant_type=refresh_token', {
            body: JSON.stringify({ refresh_token: 'refresh-original' }),
        })).rejects.toThrow('Authentication changed')
        expect(fetcher).not.toHaveBeenCalled()
        expect(JSON.parse(auth.getItem(key)!)).toEqual({ access_token: 'B', refresh_token: 'refresh-B' })
    })
    it('rejects an already admitted refresh save after another tab signs in', async () => {
        const { auth, make } = fixture(), tab = make()
        await response(auth, 'A-refreshed', 'refresh_token')
        await response(tab, 'B')
        tab.setItem(key, JSON.stringify({ access_token: 'B' }))
        expect(() => auth.setItem(key, JSON.stringify({ access_token: 'A-refreshed' }))).toThrow('after local sign-out')
        expect(JSON.parse(auth.getItem(key)!)).toEqual({ access_token: 'B' })
    })
    it('keeps a tab-only logout from clearing another tab when shared storage is unreadable', async () => {
        const { auth, disk } = fixture()
        const separateBackup = store()
        const other = createAuthInvalidation(createAuthStorage(() => disk), createAuthStorage(() => separateBackup), key, () => {})
        await response(other, 'B')
        other.setItem(key, JSON.stringify({ access_token: 'B' }))
        const before = [...disk.values]
        auth.invalidate(false)
        expect([...disk.values]).toEqual(before)
        expect(auth.getItem(key)).toBeNull()
        expect(JSON.parse(other.getItem(key)!)).toEqual({ access_token: 'B' })
    })
    it('fails closed on a corrupt logout marker and keeps unrelated HTTP errors intact', async () => {
        const { auth, disk } = fixture()
        disk.setItem(auth.revisionKey, '{bad')
        expect(auth.getItem(key)).toBeNull()
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"unavailable"}', { status: 503 }))
        const result = await auth.fetch(fetcher)('http://local/auth/v1/logout')
        expect(result.status).toBe(503)
        expect(await result.json()).toEqual({ error: 'unavailable' })
    })
})
