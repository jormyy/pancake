import { expect, it, vi } from 'vitest'
import { getPicksForMembers } from '@/lib/trades'
import { fetchUserLeagues, isTradingClosed } from '@/lib/league'
const state = vi.hoisted(() => ({ drafts: [] as Record<string, unknown>[], selection: '', tables: [] as string[] }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => {
    state.tables.push(table)
    const filters: ((row: Record<string, unknown>) => boolean)[] = []
    const rows = table === 'drafts' ? state.drafts : table === 'league_members' ? [{ user_id: 'user', leagues: { status: 'drafting', drafts: state.drafts } }] : [
        { id: 'current', current_owner_id: 'me', season_year: 2027, is_used: false, league_id: 'league', round: 1 },
        { id: 'future', current_owner_id: 'me', season_year: 2028, is_used: false, league_id: 'league', round: 1 },
    ]
    const query = { select: (selection: string) => { state.selection = selection; return query }, order: () => query, is: () => query,
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query },
        single: async () => ({ data: { future_pick_years: 5, league_seasons: [{ season_year: 2027 }] }, error: null }),
        gte: (key: string, value: number) => { filters.push(row => Number(row[key]) >= value); return query },
        lte: (key: string, value: number) => { filters.push(row => Number(row[key]) <= value); return query },
        in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query },
        then: (resolve: (value: unknown) => void) => Promise.resolve({ data: rows.filter(row => filters.every(filter => filter(row))), error: null }).then(resolve),
    }
    return query
} } }))
it('keeps setup closed and opens the dynasty trade window after setup', () => {
    expect(isTradingClosed({ status: 'setup' })).toBe(true)
    expect(isTradingClosed({ status: 'drafting', hasStartupAuction: false })).toBe(false)
    for (const status of ['offseason', 'drafting', 'active', 'playoffs'] as const) expect(isTradingClosed({ status })).toBe(false)
})

it.each(['in_progress', 'paused'])('omits current draft picks from the composer while %s', async status => {
    state.drafts = [{ league_id: 'league', draft_type: 'snake', is_mock: false, status, league_seasons: { season_year: 2027 } }]
    expect((await getPicksForMembers(['me'], 'league', { tradeableOnly: true })).me.map(pick => pick.pickId)).toEqual(['future'])
    expect((await getPicksForMembers(['me'], 'league')).me.map(pick => pick.pickId)).toEqual(['current', 'future'])
})

it.each(['pending', 'completed'])('keeps picks available before or after the draft: %s', async status => {
    state.drafts = [{ league_id: 'league', draft_type: 'snake', is_mock: false, status, league_seasons: { season_year: 2027 } }]
    expect((await getPicksForMembers(['me'], 'league', { tradeableOnly: true })).me).toHaveLength(2)
})

it('gets auction trade status in the existing membership query without another read', async () => {
    state.drafts = [{ draft_type: 'auction', is_mock: false, status: 'pending', league_seasons: { is_current: true } }]
    state.tables = []
    const memberships = await fetchUserLeagues('user')
    expect(state.tables).toEqual(['league_members'])
    expect(state.selection).toContain('drafts!drafts_league_id_fkey (draft_type, is_mock, status, league_seasons (is_current))')
    expect(isTradingClosed(memberships[0].leagues)).toBe(true)
})
