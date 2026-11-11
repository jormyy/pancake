import { beforeEach, expect, it, vi } from 'vitest'
import { getPicksForMembers } from '@/lib/trades'

const state = vi.hoisted(() => ({ horizon: 5, error: null as null | Error, calls: [] as unknown[][], year: 2027, drafts: [] as { league_seasons: { season_year: number } }[] }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => {
    let first = -Infinity
    let last = Infinity
    const query = {
        select: (...args: unknown[]) => { state.calls.push([table, 'select', ...args]); return query },
        eq: (...args: unknown[]) => { state.calls.push([table, 'eq', ...args]); return query },
        in: (...args: unknown[]) => { state.calls.push([table, 'in', ...args]); return query },
        gte: (column: string, value: number) => { first = value; state.calls.push([table, 'gte', column, value]); return query },
        lte: (column: string, value: number) => { last = value; state.calls.push([table, 'lte', column, value]); return query },
        order: () => query,
        single: async () => ({ data: { future_pick_years: state.horizon, league_seasons: [{ season_year: state.year }] }, error: state.error }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: table === 'drafts' ? state.drafts : Array.from({ length: 20 }, (_, index) => 2024 + index).filter(year => year >= first && year <= last).map(season_year => ({
            id: String(season_year), current_owner_id: 'member', season_year, round: 1, original_owner: { team_name: 'Owner' },
        })), error: null }),
    }
    return query
} } }))

beforeEach(() => { state.horizon = 5; state.error = null; state.calls = []; state.year = 2027; state.drafts = [] })

it.each([3, 5, 10])('bounds available trade picks by the league’s %i-year setting', async horizon => {
    state.horizon = horizon
    const result = await getPicksForMembers(['member'], 'league', { tradeableOnly: true })
    expect(state.calls).toContainEqual(['leagues', 'select', 'future_pick_years, league_seasons!league_seasons_league_id_fkey!inner(season_year)'])
    expect(result.member.map(pick => pick.seasonYear)).toEqual(Array.from({ length: horizon + 1 }, (_, index) => 2026 + index))
    expect(result.member.at(-1)).toMatchObject({ pickId: String(2026 + horizon), seasonYear: 2026 + horizon, originalTeamName: 'Owner' })
})

it('surfaces a settings read failure instead of silently using three years', async () => {
    state.error = new Error('league unavailable')
    await expect(getPicksForMembers(['member'], 'league')).rejects.toThrow('league unavailable')
    expect(state.calls.some(call => call[0] === 'draft_picks')).toBe(false)
})

it.each([2026, 2027, 2028])('keeps the summer draft calendar identity for season ending %i', async year => {
    state.year = year
    const result = await getPicksForMembers(['member'], 'league')
    expect(result.member[0].seasonYear).toBe(year - 1)
    expect(result.member.at(-1)?.seasonYear).toBe(year + state.horizon - 1)
})

it('excludes the live rookie draft calendar year without hiding the next draft', async () => {
    state.drafts = [{ league_seasons: { season_year: 2028 } }]
    const result = await getPicksForMembers(['member'], 'league', { tradeableOnly: true })
    expect(result.member.some(pick => pick.seasonYear === 2027)).toBe(false)
    expect(result.member.some(pick => pick.seasonYear === 2028)).toBe(true)
})
