import { beforeEach, expect, it, vi } from 'vitest'
import { getPicksForMembers } from '@/lib/trades'

const state = vi.hoisted(() => ({ horizon: 5, error: null as null | Error, calls: [] as unknown[][] }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => {
    const query = {
        select: (...args: unknown[]) => { state.calls.push([table, 'select', ...args]); return query },
        eq: (...args: unknown[]) => { state.calls.push([table, 'eq', ...args]); return query },
        in: (...args: unknown[]) => { state.calls.push([table, 'in', ...args]); return query },
        gte: (...args: unknown[]) => { state.calls.push([table, 'gte', ...args]); return query },
        lte: (...args: unknown[]) => { state.calls.push([table, 'lte', ...args]); return query },
        order: () => query,
        single: async () => ({ data: { future_pick_years: state.horizon, league_seasons: [{ season_year: 2027 }] }, error: state.error }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: table === 'drafts' ? [] : [2028, 2029, 2030, 2031, 2032].map(season_year => ({
            id: String(season_year), current_owner_id: 'member', season_year, round: 1, original_owner: { team_name: 'Owner' },
        })), error: null }),
    }
    return query
} } }))

beforeEach(() => { state.horizon = 5; state.error = null; state.calls = [] })

it.each([3, 5, 10])('bounds available trade picks by the league’s %i-year setting', async horizon => {
    state.horizon = horizon
    const result = await getPicksForMembers(['member'], 'league', { tradeableOnly: true })
    expect(state.calls).toContainEqual(['leagues', 'select', 'future_pick_years, league_seasons!league_seasons_league_id_fkey!inner(season_year)'])
    expect(state.calls).toContainEqual(['draft_picks', 'gte', 'season_year', 2027])
    expect(state.calls).toContainEqual(['draft_picks', 'lte', 'season_year', 2027 + horizon])
    expect(result.member.at(-1)).toMatchObject({ pickId: '2032', seasonYear: 2032, originalTeamName: 'Owner' })
})

it('surfaces a settings read failure instead of silently using three years', async () => {
    state.error = new Error('league unavailable')
    await expect(getPicksForMembers(['member'], 'league')).rejects.toThrow('league unavailable')
    expect(state.calls.some(call => call[0] === 'draft_picks')).toBe(false)
})
