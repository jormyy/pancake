import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMatchupGameTimes } from '@/hooks/use-matchup-game-times'
import type { NBAGameRow } from '@/lib/games'

const queries = vi.hoisted(() => ({ games: vi.fn(), league: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: (table: string) => ({ select: () => table === 'nba_games' ? { in: queries.games } : { eq: () => ({ maybeSingle: queries.league }) } }) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useMatchupGameTimes>
function Probe({ id }: { id?: string }) {
    latest = useMatchupGameTimes(id ? [{ id } as NBAGameRow] : [], 'league')
    return null
}
afterEach(async () => { await act(async () => screen?.unmount()); vi.resetAllMocks() })
it('loads the actual game timestamp and league timezone for display', async () => {
    queries.games.mockResolvedValue({ data: [{ id: 'game', game_time: '2026-10-28T23:00:42Z' }], error: null })
    queries.league.mockResolvedValue({ data: { timezone: 'America/New_York' }, error: null })
    await act(async () => { screen = create(React.createElement(Probe, { id: 'game' })) })
    expect(queries.games).toHaveBeenCalledWith('id', ['game'])
    expect(latest?.values.get('game')).toBe('2026-10-28T23:00:42Z')
    expect(latest?.timezone).toBe('America/New_York')
})
it('does not display an old slate after the selected day changes', async () => {
    let finish!: (value: unknown) => void
    queries.games.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    queries.league.mockResolvedValue({ data: { timezone: 'America/Los_Angeles' } })
    await act(async () => { screen = create(React.createElement(Probe, { id: 'old' })) })
    await act(async () => { screen.update(React.createElement(Probe, {})) })
    await act(async () => { finish({ data: [{ id: 'old', game_time: '2026-10-28T23:00:42Z' }], error: null }) })
    expect(latest).toBeNull()
    expect(queries.games).toHaveBeenCalledTimes(1)
})
