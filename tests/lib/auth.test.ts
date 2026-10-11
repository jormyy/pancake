import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
    invalidateLocalAuthSession: vi.fn(),
    captureLocalAuthSession: vi.fn(),
    localAuthSessionMatches: vi.fn(),
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
import { supabase, captureLocalAuthSession, localAuthSessionMatches, invalidateLocalAuthSession } from '@/lib/supabase'
import { detachWebPushFromAccount } from '@/lib/web-push'
import { clearPersistentCaches } from '@/lib/persistent-cache'
import { setSessionOwner } from '@/lib/session-cache-registry'

const mockAuth = vi.mocked(supabase.auth)
const mockFrom = vi.mocked(supabase.from)

describe('signOut', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockAuth.initialize.mockResolvedValue({ error: null })
        setSessionOwner('auth-test-owner')
        vi.mocked(captureLocalAuthSession).mockReturnValue({ session: { access_token: 'captured-A', user: { id: 'auth-test-owner' } } } as never)
        vi.mocked(localAuthSessionMatches).mockReturnValue(true)
        vi.mocked(invalidateLocalAuthSession).mockImplementation(async (_expected, stillCurrent) => {
            if (!stillCurrent()) return false
            clearPersistentCaches()
            return true
        })
    })
    afterEach(() => { vi.useRealTimers(); setSessionOwner(null) })

    it('refuses logout while startup is pending without queuing a late logout', async () => {
        vi.useFakeTimers()
        let complete!: () => void
        mockAuth.initialize.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ error: null }) }))
        const rejected = expect(signOut()).rejects.toThrow('Your session is still starting')
        await vi.advanceTimersByTimeAsync(5000)
        await rejected
        expect(detachWebPushFromAccount).not.toHaveBeenCalled()
        expect(mockAuth.signOut).not.toHaveBeenCalled()
        expect(invalidateLocalAuthSession).not.toHaveBeenCalled()
        expect(clearPersistentCaches).not.toHaveBeenCalled()
        complete()
        await vi.advanceTimersByTimeAsync(0)
        expect(mockAuth.signOut).not.toHaveBeenCalled()
        vi.mocked(mockAuth.admin.signOut).mockResolvedValueOnce({ data: null, error: null })
        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })
        expect(mockAuth.admin.signOut).toHaveBeenCalledOnce()
    })

    it('does not log out a different owner after waiting for startup', async () => {
        let complete!: () => void
        mockAuth.initialize.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ error: null }) }))
        const pending = signOut()
        setSessionOwner('next-auth-owner')
        complete()
        await expect(pending).rejects.toThrow('Your account changed')
        expect(detachWebPushFromAccount).not.toHaveBeenCalled()
        expect(mockAuth.signOut).not.toHaveBeenCalled()
        expect(invalidateLocalAuthSession).not.toHaveBeenCalled()
    })

    it.each(['returned', 'rejected'])('still clears the initiating session after %s startup failure', async (mode) => {
        const error = new Error('startup failed')
        if (mode === 'returned') mockAuth.initialize.mockResolvedValueOnce({ error } as never)
        else mockAuth.initialize.mockRejectedValueOnce(error)
        vi.mocked(mockAuth.admin.signOut).mockResolvedValueOnce({ data: null, error: null })
        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })
        expect(mockAuth.signOut).not.toHaveBeenCalled()
        expect(mockAuth.admin.signOut).toHaveBeenCalledWith('captured-A', 'global')
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
    })

    it('abandons the old logout when B signs in during push detach', async () => {
        vi.mocked(detachWebPushFromAccount).mockImplementationOnce(async () => { setSessionOwner('owner-B') })
        await expect(signOut()).rejects.toThrow('Your account changed')
        expect(mockAuth.admin.signOut).not.toHaveBeenCalled()
        expect(mockAuth.signOut).not.toHaveBeenCalled()
        expect(invalidateLocalAuthSession).not.toHaveBeenCalled()
        expect(clearPersistentCaches).not.toHaveBeenCalled()
    })

    it('revokes only captured A and preserves B when B signs in during the server request', async () => {
        vi.mocked(mockAuth.admin.signOut).mockImplementationOnce(async () => {
            setSessionOwner('owner-B')
            return { data: null, error: null }
        })
        await expect(signOut()).rejects.toThrow('Your account changed')
        expect(mockAuth.admin.signOut).toHaveBeenCalledWith('captured-A', 'global')
        expect(mockAuth.signOut).not.toHaveBeenCalled()
        expect(clearPersistentCaches).not.toHaveBeenCalled()
    })

    it('preserves a newer login for the same owner', async () => {
        vi.mocked(detachWebPushFromAccount).mockImplementationOnce(async () => { vi.mocked(localAuthSessionMatches).mockReturnValue(false) })
        await expect(signOut()).rejects.toThrow('Your account changed')
        expect(mockAuth.admin.signOut).not.toHaveBeenCalled()
        expect(invalidateLocalAuthSession).not.toHaveBeenCalled()
    })

    it('invalidates local identity and reports unconfirmed server logout on network failure', async () => {
        vi.mocked(mockAuth.admin.signOut)
            .mockResolvedValueOnce({ error: new Error('network') } as never)
            .mockResolvedValueOnce({ error: null } as never)

        expect(await signOut()).toEqual({ serverSignOutConfirmed: false })

        expect(mockAuth.admin.signOut).toHaveBeenNthCalledWith(1, 'captured-A', 'global')
        expect(mockAuth.admin.signOut).toHaveBeenCalledOnce()
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(detachWebPushFromAccount).toHaveBeenCalledOnce()
    })

    it('preserves server sign-out and fences late sessions after successful revocation', async () => {
        vi.mocked(mockAuth.admin.signOut).mockResolvedValueOnce({ data: null, error: null })

        await signOut()

        expect(mockAuth.admin.signOut).toHaveBeenCalledOnce()
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(detachWebPushFromAccount).toHaveBeenCalledOnce()
    })

    it('clears the authenticated session and caches when web push cleanup fails', async () => {
        vi.mocked(detachWebPushFromAccount).mockRejectedValueOnce(new Error('offline'))
        vi.mocked(mockAuth.admin.signOut).mockResolvedValueOnce({ data: null, error: null })
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await signOut()

        expect(mockAuth.admin.signOut).toHaveBeenCalledOnce()
        expect(clearPersistentCaches).toHaveBeenCalledOnce()
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
