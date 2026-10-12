import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
    invalidateLocalAuthSession: vi.fn(),
    captureLocalAuthSession: vi.fn(),
    localAuthSessionMatches: vi.fn(),
    readStoredSessionTokens: vi.fn(),
    revokeDetachedSession: vi.fn(),
    supabase: {
        auth: {
            initialize: vi.fn(),
            signUp: vi.fn(),
            signOut: vi.fn(),
            admin: { signOut: vi.fn() },
        },
        from: vi.fn(),
    },
}))
vi.mock('@/lib/web-push', () => ({ detachWebPushFromAccount: vi.fn(), prepareWebPushLogin: vi.fn(async () => null), completeWebPushLogin: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ clearPersistentCaches: vi.fn() }))

import { signOut, signUp } from '@/lib/auth'
import {
    supabase, captureLocalAuthSession, localAuthSessionMatches, invalidateLocalAuthSession, readStoredSessionTokens, revokeDetachedSession,
} from '@/lib/supabase'
import { detachWebPushFromAccount } from '@/lib/web-push'
import { clearPersistentCaches } from '@/lib/persistent-cache'
import { setSessionOwner } from '@/lib/session-cache-registry'

const mockAuth = vi.mocked(supabase.auth)
const mockFrom = vi.mocked(supabase.from)
const tokens = { access_token: 'stored-access', refresh_token: 'stored-refresh' }

describe('signOut', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockAuth.initialize.mockResolvedValue({ error: null })
        mockAuth.signOut.mockResolvedValue({ error: null } as never)
        setSessionOwner('owner-A')
        vi.mocked(captureLocalAuthSession).mockReturnValue({ session: { access_token: 'captured-A', user: { id: 'owner-A' } } } as never)
        vi.mocked(localAuthSessionMatches).mockReturnValue(true)
        vi.mocked(readStoredSessionTokens).mockReturnValue(tokens)
        // Like the real helper: clears only while the captured account is still current, then drops the owner.
        vi.mocked(invalidateLocalAuthSession).mockImplementation(async (_expected, stillCurrent) => {
            if (!stillCurrent()) return false
            clearPersistentCaches()
            setSessionOwner(null)
            return true
        })
        vi.mocked(revokeDetachedSession).mockImplementation(async (_tokens, beforeRevoke) => {
            await beforeRevoke('fresh-access')
            return true
        })
    })
    afterEach(() => { vi.useRealTimers(); setSessionOwner(null) })

    it('signs this device out before any server call, then cleans up as the captured account', async () => {
        const order: string[] = []
        vi.mocked(invalidateLocalAuthSession).mockImplementationOnce(async () => { order.push('local'); setSessionOwner(null); return true })
        mockAuth.initialize.mockImplementationOnce(async () => { order.push('startup'); return { error: null } })
        mockAuth.signOut.mockImplementationOnce(async () => { order.push('sdk-local'); return { error: null } as never })
        vi.mocked(revokeDetachedSession).mockImplementationOnce(async (_tokens, beforeRevoke) => {
            order.push('revoke')
            await beforeRevoke('fresh-access')
            return true
        })
        vi.mocked(detachWebPushFromAccount).mockImplementationOnce(async () => { order.push('push') })

        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })

        expect(order).toEqual(['local', 'startup', 'sdk-local', 'revoke', 'push'])
        expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' })
        expect(revokeDetachedSession).toHaveBeenCalledWith(tokens, expect.any(Function))
        expect(detachWebPushFromAccount).toHaveBeenCalledOnce()
        expect(vi.mocked(detachWebPushFromAccount).mock.calls[0][0]).toEqual({ ownerId: 'owner-A', accessToken: 'fresh-access' })
        expect(mockAuth.admin.signOut).not.toHaveBeenCalled()
    })

    it('refuses before clearing anything when the account already changed', async () => {
        vi.mocked(localAuthSessionMatches).mockReturnValue(false)
        await expect(signOut()).rejects.toThrow('Your account changed')
        expect(invalidateLocalAuthSession).not.toHaveBeenCalled()
        expect(revokeDetachedSession).not.toHaveBeenCalled()
        expect(detachWebPushFromAccount).not.toHaveBeenCalled()
    })

    it('leaves a newer login intact when the captured session no longer matches at clear time', async () => {
        vi.mocked(invalidateLocalAuthSession).mockResolvedValueOnce(false)
        await expect(signOut()).rejects.toThrow('Your account changed')
        expect(clearPersistentCaches).not.toHaveBeenCalled()
        expect(revokeDetachedSession).not.toHaveBeenCalled()
        expect(detachWebPushFromAccount).not.toHaveBeenCalled()
    })

    it('clears locally at once while startup is pending, then finishes server cleanup after the bounded wait', async () => {
        vi.useFakeTimers()
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        mockAuth.initialize.mockImplementationOnce(() => new Promise(() => undefined))
        const pending = signOut()
        await vi.advanceTimersByTimeAsync(0)
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(clearPersistentCaches).toHaveBeenCalledOnce()
        expect(revokeDetachedSession).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(5000)
        expect(await pending).toEqual({ serverSignOutConfirmed: true })
        // A late SDK sign-out is not queued behind a stuck startup; storage is already cleared.
        expect(mockAuth.signOut).not.toHaveBeenCalled()
        expect(revokeDetachedSession).toHaveBeenCalledOnce()
    })

    it.each(['returned', 'rejected'])('still clears and revokes after a %s startup failure', async (mode) => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const error = new Error('startup failed')
        if (mode === 'returned') mockAuth.initialize.mockResolvedValueOnce({ error } as never)
        else mockAuth.initialize.mockRejectedValueOnce(error)
        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(revokeDetachedSession).toHaveBeenCalledWith(tokens, expect.any(Function))
    })

    it('revokes captured A but never clears B when B signs in during server cleanup', async () => {
        vi.mocked(revokeDetachedSession).mockImplementationOnce(async (_tokens, beforeRevoke) => {
            setSessionOwner('owner-B')
            await beforeRevoke('fresh-access')
            return true
        })
        vi.mocked(detachWebPushFromAccount).mockImplementationOnce(async (_logout, stillCurrent) => {
            expect(stillCurrent?.()).toBe(false)
        })
        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(clearPersistentCaches).toHaveBeenCalledOnce()
    })

    it('keeps local sign-out and reports unconfirmed server logout on network failure', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.mocked(revokeDetachedSession).mockRejectedValueOnce(new Error('network'))
        expect(await signOut()).toEqual({ serverSignOutConfirmed: false })
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        // Without a usable session the browser subscription is still stopped locally.
        expect(vi.mocked(detachWebPushFromAccount).mock.calls[0][0]).toEqual({ ownerId: 'owner-A', accessToken: null })
    })

    it('reports unconfirmed server logout when revocation is refused', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.mocked(revokeDetachedSession).mockResolvedValueOnce(false)
        expect(await signOut()).toEqual({ serverSignOutConfirmed: false })
        expect(detachWebPushFromAccount).toHaveBeenCalledOnce()
    })

    it('still revokes the server session when web push cleanup fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.mocked(detachWebPushFromAccount).mockRejectedValueOnce(new Error('offline'))
        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })
        expect(clearPersistentCaches).toHaveBeenCalledOnce()
        expect(detachWebPushFromAccount).toHaveBeenCalledOnce()
    })

    it('has nothing to revoke without a stored session', async () => {
        vi.mocked(readStoredSessionTokens).mockReturnValue(null)
        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(revokeDetachedSession).not.toHaveBeenCalled()
        expect(vi.mocked(detachWebPushFromAccount).mock.calls[0][0]).toEqual({ ownerId: 'owner-A', accessToken: null })
    })
})

describe('signUp', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates profile creation to the auth trigger with the requested metadata', async () => {
        mockAuth.signUp.mockResolvedValueOnce({
            data: { user: { id: 'user-1' } },
            error: null,
        } as never)

        await signUp('new@example.test', 'password-1', 'new_manager', 'New Manager')

        expect(mockAuth.signUp).toHaveBeenCalledWith({
            email: 'new@example.test',
            password: 'password-1',
            options: { data: { username: 'new_manager', display_name: 'New Manager' } },
        })
        expect(mockFrom).not.toHaveBeenCalled()
        expect(mockAuth.signOut).not.toHaveBeenCalled()
    })
})
