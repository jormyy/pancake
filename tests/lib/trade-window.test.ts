import { expect, it, vi } from 'vitest'
import { getPicksForMembers } from '@/lib/trades'
import { isTradingClosed } from '@/lib/league'
const state = vi.hoisted(() => ({ drafts: [] as Record<string, unknown>[] }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = []
    const rows = table === 'drafts' ? state.drafts : [
        { id: 'current', current_owner_id: 'me', season_year: 2027, is_used: false, league_id: 'league', round: 1 },
        { id: 'future', current_owner_id: 'me', season_year: 2028, is_used: false, league_id: 'league', round: 1 },
    ]
    const query = { select: () => query, order: () => query,
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query },
        in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query },
        then: (resolve: (value: unknown) => void) => Promise.resolve({ data: rows.filter(row => filters.every(filter => filter(row))), error: null }).then(resolve),
    }
    return query
} } }))
it('keeps setup closed and opens the dynasty trade window after setup', () => {
    expect(isTradingClosed({ status: 'setup' })).toBe(true)
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
