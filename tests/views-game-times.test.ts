import { expect, it, vi } from 'vitest'
import { withGameTimes } from '../supabase/functions/api/views/game-times'

it('returns game lines and timestamps in the same response', async () => {
    const load = vi.fn().mockResolvedValue([{ id: 'game', game_time: '2026-10-28T23:00:00Z' }])
    const result = await withGameTimes({ todaysGames: [{ id: 'game', home_team: 'CLE', away_team: 'WAS' }] }, load)
    expect(result.todaysGames).toEqual([{ id: 'game', home_team: 'CLE', away_team: 'WAS', game_time: '2026-10-28T23:00:00Z' }])
    expect(load).toHaveBeenCalledExactlyOnceWith(['game'])
    expect(await withGameTimes(result, load)).toBe(result)
    expect(load).toHaveBeenCalledTimes(1)
})
