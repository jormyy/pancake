import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
    invalidateLocalAuthSession: vi.fn(),
    supabase: {
        auth: {
            signUp: vi.fn(),
            signOut: vi.fn(),
        },
        from: vi.fn(),
    },
}))
vi.mock('@/lib/web-push', () => ({ detachWebPushFromAccount: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ clearPersistentCaches: vi.fn() }))

import { signOut, signUp } from '@/lib/auth'
import { supabase, invalidateLocalAuthSession } from '@/lib/supabase'
import { detachWebPushFromAccount } from '@/lib/web-push'
import { clearPersistentCaches } from '@/lib/persistent-cache'

const mockAuth = vi.mocked(supabase.auth)
const mockFrom = vi.mocked(supabase.from)

describe('signOut', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('invalidates local identity and reports unconfirmed server logout on network failure', async () => {
        mockAuth.signOut
            .mockResolvedValueOnce({ error: new Error('network') } as never)
            .mockResolvedValueOnce({ error: null } as never)

        expect(await signOut()).toEqual({ serverSignOutConfirmed: false })

        expect(mockAuth.signOut).toHaveBeenNthCalledWith(1)
        expect(mockAuth.signOut).toHaveBeenCalledOnce()
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(detachWebPushFromAccount).toHaveBeenCalledOnce()
    })

    it('preserves server sign-out and fences late sessions after successful revocation', async () => {
        mockAuth.signOut.mockResolvedValueOnce({ error: null } as never)

        await signOut()

        expect(mockAuth.signOut).toHaveBeenCalledOnce()
        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(detachWebPushFromAccount).toHaveBeenCalledOnce()
    })

    it('clears the authenticated session and caches when web push cleanup fails', async () => {
        vi.mocked(detachWebPushFromAccount).mockRejectedValueOnce(new Error('offline'))
        mockAuth.signOut.mockResolvedValueOnce({ error: null } as never)
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await signOut()

        expect(mockAuth.signOut).toHaveBeenCalledOnce()
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
