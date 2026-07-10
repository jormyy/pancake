import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
    supabase: {
        auth: {
            signUp: vi.fn(),
            signOut: vi.fn(),
        },
        from: vi.fn(),
    },
}))
vi.mock('@/lib/push-token', () => ({ unregisterCurrentDevicePushToken: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ clearPersistentCaches: vi.fn() }))

import { signOut, signUp } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { unregisterCurrentDevicePushToken } from '@/lib/push-token'
import { clearPersistentCaches } from '@/lib/persistent-cache'

const mockAuth = vi.mocked(supabase.auth)
const mockFrom = vi.mocked(supabase.from)

describe('signOut', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('uses a local fallback when server sign-out returns an error', async () => {
        mockAuth.signOut
            .mockResolvedValueOnce({ error: new Error('network') } as never)
            .mockResolvedValueOnce({ error: null } as never)

        await signOut()

        expect(mockAuth.signOut).toHaveBeenNthCalledWith(1)
        expect(mockAuth.signOut).toHaveBeenNthCalledWith(2, { scope: 'local' })
        expect(unregisterCurrentDevicePushToken).toHaveBeenCalledOnce()
    })

    it('does not run the local fallback after a successful server sign-out', async () => {
        mockAuth.signOut.mockResolvedValueOnce({ error: null } as never)

        await signOut()

        expect(mockAuth.signOut).toHaveBeenCalledOnce()
        expect(unregisterCurrentDevicePushToken).toHaveBeenCalledOnce()
    })

    it('clears the authenticated session and caches when push-token cleanup fails', async () => {
        vi.mocked(unregisterCurrentDevicePushToken).mockRejectedValueOnce(new Error('offline'))
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

    it('signs the user back out and surfaces the profile error when profile creation fails', async () => {
        mockAuth.signUp.mockResolvedValueOnce({
            data: { user: { id: 'user-1' } },
            error: null,
        } as never)
        mockAuth.signOut.mockResolvedValueOnce({ error: null } as never)
        const insert = vi.fn().mockResolvedValue({
            error: { message: 'duplicate username' },
        })
        mockFrom.mockReturnValue({ insert } as never)

        await expect(signUp('new@example.test', 'password-1', 'taken', 'Taken User'))
            .rejects.toThrow('Could not create your profile (duplicate username).')

        expect(mockFrom).toHaveBeenCalledWith('profiles')
        expect(insert).toHaveBeenCalledWith({
            id: 'user-1',
            username: 'taken',
            display_name: 'Taken User',
        })
        expect(mockAuth.signOut).toHaveBeenCalledOnce()
    })
})
