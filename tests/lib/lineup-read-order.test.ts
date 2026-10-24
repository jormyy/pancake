import { beforeEach, expect, it, vi } from 'vitest'
import { getWeeklyLineup } from '@/lib/lineup/read'
import { clearSessionCaches } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({
    roster: [] as Record<string, unknown>[],
    assignments: [] as Record<string, unknown>[],
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2099-01-01' }))
vi.mock('@/lib/supabase', () => ({ supabase: {
    from: (table: string) => {
        let order: string | undefined
        const query: object = new Proxy({}, { get: (_, name) => {
            if (name === 'then') return (resolve: (value: unknown) => void) => {
                const rows = table === 'roster_players' ? state.roster : table === 'weekly_lineups' ? state.assignments
                    : [{ slot_type: 'PG', slot_count: 2 }, { slot_type: 'BE', slot_count: 4 }]
                const data = order ? [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!]))) : rows
                resolve({ data, error: null })
            }
            return (column: string) => { if (name === 'order') order = column; return query }
        } })
        return query
    },
} }))

beforeEach(() => {
    clearSessionCaches()
    state.roster = ['d', 'b', 'c', 'a'].map(id => ({ id: `roster-${id}`, player_id: id, is_on_ir: false, is_on_taxi: false,
        players: { display_name: id, position: 'PG', eligible_positions: ['PG'] } }))
    state.assignments = ['b', 'a'].map(id => ({ player_id: id, slot_type: 'PG' }))
})

it('keeps starter and bench indexes stable when the database changes its row order', async () => {
    const read = () => getWeeklyLineup('member', 'league', 'season', 1, '2099-01-01')
    const first = await read()
    state.roster.reverse()
    state.assignments.reverse()
    const second = await read()
    expect(first.starters.map(slot => slot.player?.playerId)).toEqual(['a', 'b'])
    expect(first.bench.map(player => player.playerId)).toEqual(['c', 'd'])
    expect(second).toEqual(first)
})
