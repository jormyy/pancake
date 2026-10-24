import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../supabase/functions/_shared/supabase.ts', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('../supabase/functions/_shared/apiRuntime.ts', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    requireUser: async () => '22222222-2222-4222-8222-222222222222',
    requireOwnMember: async () => ({ leagueId: '66666666-6666-4666-8666-666666666666' }),
}))

const apiPath = '../supabase/functions/api/trades.ts'
const tradeId = '11111111-1111-4111-8111-111111111111'
const memberId = '33333333-3333-4333-8333-333333333333'
const recipientMemberId = '44444444-4444-4444-8444-444444444444'
const requestId = '55555555-5555-4555-8555-555555555555'
const playerId = '77777777-7777-4777-8777-777777777777'

beforeEach(() => {
    vi.clearAllMocks()
    mocks.rpc.mockResolvedValue({ data: tradeId, error: null })
})

const send = async (action: string, body: Record<string, unknown>) => {
    const { handleTradeRoute } = await import(apiPath)
    const path = `/trades/${tradeId}/${action}`
    return handleTradeRoute(new Request(`https://example.test${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), path) as Promise<Response>
}

it.each(['edit', 'counter'])('forwards the reviewed counterparty for %s', async (action) => {
    const response = await send(action, { memberId, requestId, recipientMemberId, offerFaabAmount: 1, requestFaabAmount: 1 })
    expect(response.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('submit_trade_offer_atomic', expect.objectContaining({
        p_action: action, p_payload: expect.objectContaining({ tradeId, recipientMemberId }),
    }))
})

it('returns the saved roster plan for a local trade update', async () => {
    const rosterPlan = { taxiPlayerIds: [playerId], irPlayerIds: [], dropPlayerIds: [] }
    const response = await send('roster-plan', { memberId, ...rosterPlan })
    expect(await response.json()).toEqual({ ok: true, rosterPlan })
    expect(mocks.rpc).toHaveBeenCalledWith('set_trade_roster_plan_atomic', expect.objectContaining({ p_taxi_player_ids: [playerId] }))
})

it('rejects an invalid replacement recipient before the database call', async () => {
    await expect(send('edit', { memberId, requestId, recipientMemberId: 'wrong' })).rejects.toThrow(/recipientMemberId/)
    expect(mocks.rpc).not.toHaveBeenCalled()
})
