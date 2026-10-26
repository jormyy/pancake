import { beforeEach, expect, it, vi } from 'vitest'
import { getPlayerSeasonAverages, getPlayerAverageFantasyPoints } from '@/lib/players'

const state = vi.hoisted(() => ({ single: vi.fn(), eq: vi.fn(), select: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: state.from } }))
beforeEach(() => {
    vi.clearAllMocks()
    state.from.mockReturnValue({ select: state.select })
    state.select.mockReturnValue({ eq: state.eq })
    state.eq.mockReturnValue({ eq: state.eq, maybeSingle: state.single })
})

it('reads only the requested player and season and maps the stored summary', async () => {
    state.single.mockResolvedValue({ data: { games_played: 4, avg_points: 24, avg_assists: 7, avg_turnovers: 3, double_doubles: 2 }, error: null })
    const averages = await getPlayerSeasonAverages('player', 2027)
    expect(state.from).toHaveBeenCalledWith('mv_player_season_averages')
    expect(state.eq.mock.calls).toEqual([['player_id', 'player'], ['season_year', 2027]])
    expect(averages).toMatchObject({ gamesPlayed: 4, avgPoints: 24, avgAssists: 7, avgBlocks: 0, doubleDoubles: 2 })
})

it.each([null, { games_played: 0 }])('returns no averages when there are no played games: %j', async data => {
    state.single.mockResolvedValue({ data, error: null })
    expect(await getPlayerSeasonAverages('player', 2027)).toBeNull()
})

it('surfaces a summary read failure for the independent error state', async () => {
    state.single.mockResolvedValue({ data: null, error: new Error('unavailable') })
    await expect(getPlayerSeasonAverages('player', 2027)).rejects.toThrow('unavailable')
})

it('reads the server fantasy average without recalculating from rounded stat averages', async () => {
    state.single.mockResolvedValue({ data: { avg_fantasy_points: 35.13 }, error: null })
    expect(await getPlayerAverageFantasyPoints('player', 'league', 2027)).toBe(35.13)
    expect(state.from).toHaveBeenCalledWith('v_player_avg_fantasy_points')
    expect(state.eq.mock.calls).toEqual([['player_id', 'player'], ['league_id', 'league'], ['season_year', 2027]])
})
