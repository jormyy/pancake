import { beforeEach, expect, it, vi } from 'vitest'
import { rosterPlayer } from '../helpers/fixtures'

const query = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), eq: vi.fn(), in: vi.fn(), order: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: query.from } }))
import { getTradePlayerValues, withTradeRosterValues } from '@/lib/trade-player-values'

beforeEach(() => {
    vi.resetAllMocks()
    for (const call of [query.from, query.select, query.eq, query.in]) call.mockReturnValue(query)
    query.order.mockReturnValueOnce(query).mockResolvedValueOnce({ data: [
        { player_id: 'player-a', trade_value: 900 },
        { player_id: 'player-a', trade_value: 100 },
        { player_id: 'player-b', trade_value: null },
        { player_id: 'player-b', trade_value: 800 },
    ], error: null })
})

it('reads the newest imported values without replacing a missing value with an older one', async () => {
    expect(await getTradePlayerValues(['player-a', 'player-a', 'player-b'])).toEqual(new Map([['player-a', 900], ['player-b', null]]))
    expect(query.from).toHaveBeenCalledWith('dynasty_rankings')
    expect(query.eq).toHaveBeenCalledWith('source', 'onenumberhoops.com')
    expect(query.in).toHaveBeenCalledWith('player_id', ['player-a', 'player-b'])
    expect(query.order.mock.calls).toEqual([['fetched_at', { ascending: false }], ['source_rank', { ascending: true }]])
})

it('attaches values to trade rosters without sorting or changing the original team rosters', async () => {
    const player = rosterPlayer()
    const rosters = { me: [player], them: [] }
    const result = await withTradeRosterValues(rosters)
    expect(result.me).toEqual([{ ...player, tradeValue: 900 }])
    expect(result.them).toEqual([])
    expect(rosters.me[0]).toBe(player)
    expect(player).not.toHaveProperty('tradeValue')
})

it('does not fetch for an empty player list', async () => {
    expect(await getTradePlayerValues([])).toEqual(new Map())
    expect(query.from).not.toHaveBeenCalled()
})

it.each(['response error', 'rejected request'])('keeps trade roster assets when optional rankings fail with a %s', async failure => {
    query.order.mockReset().mockReturnValueOnce(query)
    if (failure === 'response error') query.order.mockResolvedValueOnce({ data: null, error: new Error('rankings unavailable') })
    else query.order.mockRejectedValueOnce(new Error('rankings unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const player = rosterPlayer()
    const rosters = { me: [player], them: [] }
    try {
        expect(await withTradeRosterValues(rosters)).toEqual({ me: [{ ...player, tradeValue: null }], them: [] })
        expect(rosters).toEqual({ me: [player], them: [] })
        expect(player).not.toHaveProperty('tradeValue')
    } finally {
        warn.mockRestore()
    }
})
