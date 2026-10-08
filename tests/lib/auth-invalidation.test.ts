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
    disk.setItem(key, JSON.stringify({ access_token: 'old' }))
    const make = () => createAuthInvalidation(createAuthStorage(() => disk), createAuthStorage(() => backup), key, changed)
    return { disk, backup, changed, make, auth: make() }
}
async function response(auth: ReturnType<typeof createAuthInvalidation>, token: string, grant = 'password') {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ access_token: token })))
    await auth.fetch(fetcher)(`http://local/auth/v1/token?grant_type=${grant}`)
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
        await response(auth, 'refresh', 'refresh_token')
        expect(() => auth.setItem(key, JSON.stringify({ access_token: 'refresh' }))).toThrow('after local sign-out')
        await response(auth, 'new')
        auth.setItem(key, JSON.stringify({ access_token: 'new' }))
        expect(JSON.parse(auth.getItem(key)!)).toEqual({ access_token: 'new' })
        expect(() => auth.setItem(key, JSON.stringify({ access_token: 'old' }))).toThrow('after local sign-out')
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
