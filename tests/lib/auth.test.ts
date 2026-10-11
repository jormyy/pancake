import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
    invalidateLocalAuthSession: vi.fn(),
    readStoredSessionTokens: vi.fn(),
    revokeDetachedSession: vi.fn(),
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
import { supabase, invalidateLocalAuthSession, readStoredSessionTokens, revokeDetachedSession } from '@/lib/supabase'
import { detachWebPushFromAccount } from '@/lib/web-push'
import { clearPersistentCaches } from '@/lib/persistent-cache'

const mockAuth = vi.mocked(supabase.auth)
const mockFrom = vi.mocked(supabase.from)
const tokens = { access_token: 'stored-access', refresh_token: 'stored-refresh' }

describe('signOut', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(readStoredSessionTokens).mockReturnValue(tokens)
        mockAuth.signOut.mockResolvedValue({ error: null } as never)
        vi.mocked(revokeDetachedSession).mockImplementation(async (_tokens, beforeRevoke) => {
            await beforeRevoke('fresh-access')
            return true
        })
    })

    it('signs this device out before any server call', async () => {
        const order: string[] = []
        vi.mocked(invalidateLocalAuthSession).mockImplementation(async () => { order.push('local') })
        vi.mocked(revokeDetachedSession).mockImplementation(async (_tokens, beforeRevoke) => {
            order.push('revoke')
            await beforeRevoke('fresh-access')
            return true
        })
        vi.mocked(detachWebPushFromAccount).mockImplementation(async () => { order.push('push') })

        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })

        expect(order).toEqual(['local', 'revoke', 'push'])
        expect(clearPersistentCaches).toHaveBeenCalledOnce()
        expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' })
        expect(revokeDetachedSession).toHaveBeenCalledWith(tokens, expect.any(Function))
        expect(detachWebPushFromAccount).toHaveBeenCalledWith('fresh-access')
    })

    it('keeps local sign-out and reports unconfirmed server logout on network failure', async () => {
        vi.mocked(revokeDetachedSession).mockRejectedValueOnce(new Error('network'))
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        expect(await signOut()).toEqual({ serverSignOutConfirmed: false })

        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
    })

    it('reports unconfirmed server logout when revocation is refused', async () => {
        vi.mocked(revokeDetachedSession).mockResolvedValueOnce(false)
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        expect(await signOut()).toEqual({ serverSignOutConfirmed: false })
    })

    it('still revokes the server session when web push cleanup fails', async () => {
        vi.mocked(detachWebPushFromAccount).mockRejectedValueOnce(new Error('offline'))
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })
        expect(clearPersistentCaches).toHaveBeenCalledOnce()
    })

    it('has nothing to revoke without a stored session', async () => {
        vi.mocked(readStoredSessionTokens).mockReturnValue(null)

        expect(await signOut()).toEqual({ serverSignOutConfirmed: true })

        expect(invalidateLocalAuthSession).toHaveBeenCalledOnce()
        expect(revokeDetachedSession).not.toHaveBeenCalled()
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
