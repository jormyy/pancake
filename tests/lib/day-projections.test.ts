import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDayProjections, sleeperProjectionPoints, type SleeperProjectionRow } from '@/lib/projections'
import { useDayProjections } from '@/hooks/use-day-projections'

const db = vi.hoisted(() => ({ rows: vi.fn(), select: vi.fn(), eq: vi.fn(), in: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => {
    expect(table).toBe('sleeper_projection_rows')
    const query = {
        select: (columns: string) => { db.select(columns); return query },
        eq: (column: string, value: string) => { db.eq(column, value); return query },
        in: (column: string, values: string[]) => { db.in(column, values); return db.rows() },
    }
    return query
} } }))
vi.mock('@/lib/league-daily-cache', () => ({ readLeagueDaily: (_league: string, _key: string, read: () => Promise<unknown>) => read() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings = { points: 1, rebounds: 1.2, assists: 1.5, steals: 3, blocks: 3, turnovers: -1, three_pointers_made: 0.5, double_double: 2, triple_double: 5 }
const line = (overrides: Partial<SleeperProjectionRow> = {}): SleeperProjectionRow => ({
    player_id: 'a', team: 'LAL', game_date: '2026-11-24', last_modified: 1,
    points: 20, rebounds: 8, assists: 6, steals: 1, blocks: 0.5, three_pointers_made: 2, turnovers: 3,
    field_goals_made: 7, field_goals_attempted: 15, free_throws_made: 4, free_throws_attempted: 5,
    double_doubles: 0.25, triple_doubles: 0.05, ...overrides,
})
const player = (playerId: string, nbaTeam: string | null = 'LAL') => ({ rosterPlayerId: playerId, playerId, displayName: playerId, position: 'PG', eligiblePositions: ['PG'], nbaTeam, injuryStatus: null, nbaId: null })

let screen: ReactTestRenderer | undefined
beforeEach(() => { for (const mock of Object.values(db)) mock.mockReset() })
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined })

it('scores a Sleeper stat line the way the server does', () => {
    // 20 + 9.6 + 9 + 3 + 1.5 + 1 - 3 + 0.25*2 + 0.05*5
    expect(sleeperProjectionPoints(line(), settings)).toBe(41.85)
    // Without Sleeper's expectations, 10+ categories decide: two tens is a double-double, not a triple.
    expect(sleeperProjectionPoints(line({ points: 20, rebounds: 10, assists: 4, double_doubles: null, triple_doubles: null }), settings))
        .toBe(Math.round((20 + 12 + 6 + 3 + 1.5 + 1 - 3 + 2) * 100) / 100)
    expect(sleeperProjectionPoints(line(), {})).toBe(0)
})

it('reads one day for the lineup players and keeps only rows for their current team', async () => {
    db.rows.mockResolvedValue({ data: [
        line({ player_id: 'a', last_modified: 1, points: 10 }),
        line({ player_id: 'a', last_modified: 2, points: 30 }),
        line({ player_id: 'b', team: 'BOS' }),
        line({ player_id: 'c', game_date: '2026-11-25' }),
    ], error: null })
    const projections = await getDayProjections('league', '2026-11-24', [player('a'), player('b'), player('c'), player('d', null)], settings)
    expect(db.eq).toHaveBeenCalledExactlyOnceWith('game_date', '2026-11-24')
    expect(db.in).toHaveBeenCalledExactlyOnceWith('player_id', ['a', 'b', 'c'])
    // The newest row wins; 'b' plays for LAL now, so its BOS row is ignored.
    expect([...projections]).toEqual([['a', sleeperProjectionPoints(line({ points: 30 }), settings)]])
    expect(await getDayProjections('league', '2026-11-24', [], settings)).toEqual(new Map())
    expect(db.in).toHaveBeenCalledOnce()
})

function Probe({ date }: { date: string }) {
    const lineups = React.useMemo(() => [{ starters: [{ player: player('a') }, { player: null }], bench: [player('b')] }], [])
    return React.createElement('probe', { value: [...useDayProjections('league', date, lineups, settings)] })
}

it('never shows another day\'s projections while the selected day loads', async () => {
    db.rows.mockResolvedValueOnce({ data: [line({ player_id: 'a' })], error: null })
    await act(async () => { screen = create(React.createElement(Probe, { date: '2026-11-24' })) })
    const value = () => screen!.root.findByType('probe' as React.ElementType).props.value
    expect(value()).toEqual([['a', 41.85]])
    expect(db.in.mock.calls[0][1]).toEqual(['a', 'b'])
    db.rows.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => screen!.update(React.createElement(Probe, { date: '2026-11-25' })))
    expect(value()).toEqual([])
})
