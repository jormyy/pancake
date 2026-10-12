import { describe, expect, it, vi } from 'vitest'
import { createAuthStorage } from '@/lib/auth-storage'
import { createAuthInvalidation } from '@/lib/auth-invalidation'
import { createAuthLogoutGuard } from '@/lib/auth-logout-guard'
import { authSession, fixtureProject } from '../helpers/auth-session'

const key = 'sb-auth-fixture-auth-token'
function session(owner: string, id?: string, offset = 0) {
    const value = authSession(owner, Math.floor(Date.now() / 1000) + 3600 + offset)
    const [header, body, signature] = value.access_token.split('.')
    value.access_token = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), session_id: id })).toString('base64url')}.${signature}`
    return value
}
function fixture() {
    const disk = new Map<string, string>()
    let denied = false
    const primary = createAuthStorage(() => ({
        getItem: name => { if (denied && name === key) throw new Error('denied'); return disk.get(name) ?? null },
        setItem: (name, value) => { disk.set(name, value) }, removeItem: name => { disk.delete(name) },
    }))
    const backup = new Map<string, string>()
    const fallback = createAuthStorage(() => ({ getItem: name => backup.get(name) ?? null,
        setItem: (name, value) => { backup.set(name, value) }, removeItem: name => { backup.delete(name) } }))
    const storage = createAuthInvalidation(primary, fallback, key, () => {})
    const guard = createAuthLogoutGuard(storage, key, fixtureProject, async work => work())
    return { disk, storage, guard, deny: () => { denied = true } }
}

describe('logout session identity', () => {
    it('accepts a refresh of the original session but refuses a fresh login for either owner', () => {
        const { disk, guard } = fixture()
        disk.set(key, JSON.stringify(session('A', 'session-A')))
        const expected = guard.capture()
        disk.set(key, JSON.stringify(session('A', 'session-A', 10)))
        expect(guard.matches(expected)).toBe(true)
        disk.set(key, JSON.stringify(session('A', 'fresh-A')))
        expect(guard.matches(expected)).toBe(false)
        disk.set(key, JSON.stringify(session('B', 'session-A')))
        expect(guard.matches(expected)).toBe(false)
    })
    it('requires exact tokens when legacy session ids are absent', () => {
        const { disk, guard } = fixture()
        disk.set(key, JSON.stringify(session('A')))
        const expected = guard.capture()
        expect(guard.matches(expected)).toBe(true)
        disk.set(key, JSON.stringify(session('A', undefined, 10)))
        expect(guard.matches(expected)).toBe(false)
    })
    it('does not let old SDK cleanup remove or announce logout for a newer saved session', async () => {
        const { disk, guard } = fixture()
        disk.set(key, JSON.stringify(session('A', 'session-A')))
        guard.sdkStorage.getItem(key)
        const B = JSON.stringify(session('B', 'session-B'))
        disk.set(key, B)
        const announce = vi.fn()
        const cleanup = async () => { await guard.sdkStorage.removeItem(key); announce() }
        await expect(cleanup()).rejects.toThrow('Your account changed')
        expect(disk.get(key)).toBe(B)
        expect(announce).not.toHaveBeenCalled()
    })
    it('retains denied shared availability across repeated tab-only cleanup', () => {
        const { disk, storage, guard, deny } = fixture()
        disk.set(key, JSON.stringify(session('B', 'session-B')))
        deny()
        expect(guard.capture().available).toBe(false)
        storage.invalidate(false)
        const expected = guard.capture()
        expect(expected.available).toBe(false)
        storage.invalidate(expected.available)
        expect(JSON.parse(disk.get(key)!).user.id).toBe('B')
        expect(disk.has(`${key}-local-logout`)).toBe(false)
    })
    it('allows cleanup of unchanged corrupt storage without claiming a server identity', async () => {
        const { disk, guard } = fixture()
        disk.set(key, '{invalid')
        expect(guard.capture().session).toBeNull()
        guard.sdkStorage.getItem(key)
        await guard.sdkStorage.removeItem(key)
        expect(disk.has(key)).toBe(false)
    })
})
