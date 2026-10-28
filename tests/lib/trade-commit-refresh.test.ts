import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    refresh: vi.fn(),
    invalidate: vi.fn(),
    replay: undefined as undefined | ((mutation: { path: string; body: string; id: string; accountId: string; leagueId: string }) => Promise<unknown>),
}))

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'test', user: { id: 'owner' } } } }) } } }))
vi.mock('@/lib/cache/screen-cache', () => ({ refreshScreenVersions: mocks.refresh, invalidateScreenViews: mocks.invalidate }))
vi.mock('@/lib/cache/mutation-queue', () => ({
    configureMutationReplay: (replay: typeof mocks.replay) => { mocks.replay = replay },
    pendingMutations: () => [],
    mutationRowIds: () => [],
}))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => 'owner', sessionGeneration: () => 1 }))
vi.mock('@/lib/shared/pwa-mutation', () => ({ withPwaMutation: (_label: string, send: () => Promise<unknown>) => send() }))

import { apiPost } from '@/lib/shared/api'

const tradeId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
    mocks.refresh.mockReset()
    mocks.invalidate.mockReset()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, tradeId })))
})

it.each(['/trades/propose', '/trades/propose-multi', `/trades/${tradeId}/accept`])('keeps a committed %s successful when refresh fails', async path => {
    mocks.refresh.mockRejectedValue(new Error('Internal server error'))
    await expect(apiPost(path, { leagueId: 'league' })).resolves.toEqual({ ok: true, tradeId })
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith('league'))
    expect(mocks.invalidate).toHaveBeenCalledWith('league')
})

it('returns the committed trade while its screen refresh remains pending', async () => {
    let finish!: () => void
    mocks.refresh.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    let result: unknown
    const sent = apiPost('/trades/propose', { leagueId: 'league' }).then(value => { result = value })
    try {
        await vi.waitFor(() => expect(result).toEqual({ ok: true, tradeId }), { timeout: 100 })
    } finally {
        finish()
        await sent
    }
})

it('removes a committed trade replay even when its refresh fails', async () => {
    mocks.refresh.mockRejectedValue(new Error('Internal server error'))
    await expect(mocks.replay!({ path: '/trades/propose', body: '{}', id: requestId, accountId: 'owner', leagueId: 'league' }))
        .resolves.toEqual({ ok: true, tradeId })
})
