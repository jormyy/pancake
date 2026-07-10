import { describe, expect, it, vi } from 'vitest'
import { runSignupProfileTriggerProbe } from './e2e/signup-profile-trigger.mjs'

describe('signup profile trigger probe', () => {
    it('checks exact trigger-owned metadata and always removes the auth probe', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 'user-id' } }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify([{
                id: 'user-id', username: 'manager_1230', display_name: 'Trigger Probe 1230',
            }]), { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))
        vi.stubGlobal('fetch', fetchMock)
        vi.spyOn(Date, 'now').mockReturnValue(123)
        vi.spyOn(Math, 'random').mockReturnValue(0)

        await expect(runSignupProfileTriggerProbe({
            apiUrl: 'http://supabase.test', anonKey: 'anon', serviceRoleKey: 'service',
        })).resolves.toMatchObject({ userId: 'user-id', username: 'manager_1230' })
        expect(fetchMock).toHaveBeenLastCalledWith(
            'http://supabase.test/auth/v1/admin/users/user-id',
            expect.objectContaining({ method: 'DELETE' }),
        )
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })
})
