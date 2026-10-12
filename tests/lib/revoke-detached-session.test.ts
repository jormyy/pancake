import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'public-key'
    return { setSession: vi.fn(), signOut: vi.fn() }
})
vi.mock('react-native-url-polyfill/auto', () => ({}))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('@supabase/supabase-js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@supabase/supabase-js')>()
    return {
        ...actual,
        createClient: vi.fn(() => ({ auth: { setSession: sdk.setSession, signOut: sdk.signOut } })),
    }
})

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'
import { revokeDetachedSession } from '@/lib/supabase'

const tokens = { access_token: 'access', refresh_token: 'refresh' }

describe('revokeDetachedSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        sdk.signOut.mockResolvedValue({ error: null })
    })

    it('runs cleanup with the usable token, then revokes', async () => {
        sdk.setSession.mockResolvedValue({ data: { session: { access_token: 'fresh' } }, error: null })
        const beforeRevoke = vi.fn().mockResolvedValue(undefined)

        expect(await revokeDetachedSession(tokens, beforeRevoke)).toBe(true)

        expect(sdk.setSession).toHaveBeenCalledWith(tokens)
        expect(beforeRevoke).toHaveBeenCalledWith('fresh')
        expect(sdk.signOut).toHaveBeenCalledOnce()
    })

    it.each([400, 401, 403, 404])('treats a session the server already rejects (%i) as signed out', async (status) => {
        sdk.setSession.mockResolvedValue({ data: { session: null }, error: new AuthApiError('gone', status, undefined) })
        const beforeRevoke = vi.fn()

        expect(await revokeDetachedSession(tokens, beforeRevoke)).toBe(true)

        expect(beforeRevoke).not.toHaveBeenCalled()
        expect(sdk.signOut).not.toHaveBeenCalled()
    })

    it('treats a session signed out on another device as signed out', async () => {
        // The SDK answers 403 session_not_found (the access token outlived its session) with
        // AuthSessionMissingError, not AuthApiError.
        sdk.setSession.mockResolvedValue({ data: { session: null }, error: new AuthSessionMissingError() })
        const beforeRevoke = vi.fn()

        expect(await revokeDetachedSession(tokens, beforeRevoke)).toBe(true)

        expect(beforeRevoke).not.toHaveBeenCalled()
        expect(sdk.signOut).not.toHaveBeenCalled()
    })

    it('reports an unreachable server as unconfirmed', async () => {
        sdk.setSession.mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError('offline', 0) })

        expect(await revokeDetachedSession(tokens, vi.fn())).toBe(false)
        expect(sdk.signOut).not.toHaveBeenCalled()
    })

    it('reports a refused revocation as unconfirmed', async () => {
        sdk.setSession.mockResolvedValue({ data: { session: { access_token: 'fresh' } }, error: null })
        sdk.signOut.mockResolvedValue({ error: new AuthApiError('server error', 500, undefined) })

        expect(await revokeDetachedSession(tokens, vi.fn().mockResolvedValue(undefined))).toBe(false)
    })
})
