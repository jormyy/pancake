import { beforeEach, expect, it, vi } from 'vitest'
import { counterTrade, editTrade, setTradeRosterPlan } from '@/lib/trades'

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/roster-stats', () => ({ getRosterStatsMaps: vi.fn() }))

beforeEach(() => { vi.clearAllMocks() })

it.each([counterTrade, editTrade])('sends the reviewed recipient through the client', async (replace) => {
    mocks.apiPost.mockResolvedValue({ tradeId: 'new' })
    await replace('source', 'actor', { recipientMemberId: 'reviewed', offerPlayerIds: [], requestPlayerIds: [], offerPickIds: [], requestPickIds: [], requestFaabAmount: 7 })
    expect(mocks.apiPost).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ recipientMemberId: 'reviewed', requestFaabAmount: 7 }))
})

it('returns the server roster plan to update the trade in place', async () => {
    const plan = { taxiPlayerIds: ['incoming'], irPlayerIds: [], dropPlayerIds: [] }
    const saved = { ...plan, taxiPlayerIds: [], irPlayerIds: ['incoming'] }
    mocks.apiPost.mockResolvedValue({ ok: true, rosterPlan: saved })
    expect(await setTradeRosterPlan('trade', 'member', plan)).toEqual(saved)
})
