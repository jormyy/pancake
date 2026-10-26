import { describe, expect, it, vi } from 'vitest'
import { getPlayerSeasonLines, summarizePlayerSeason } from '@/components/player/season-data'
import { seasonLine } from './season-fixtures'

const query = vi.hoisted(() => ({ select: vi.fn(), eq: vi.fn(), like: vi.fn(), order: vi.fn(), limit: vi.fn(), returns: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: query.from } }))

describe('one season stat source', () => {
    it.each([
        [true, 'DEN', 'vs BOS'], [false, 'LAL', '@ LAL'], [null, 'BOS', '@ LAL'], [undefined, 'LAL', 'vs BOS'],
        [null, 'DEN', 'BOS @ LAL'], [undefined, null, 'BOS @ LAL'],
    ])('uses the saved game side %s after a trade to %s', (isHome, team, opponent) => {
        const result = summarizePlayerSeason([{ ...seasonLine(), is_home: isHome }], team, null)
        expect(result.games[0].opponent).toBe(opponent)
    })

    it('uses one bounded player query with live status and the same regular-season scope as scoring', async () => {
        const chain = { select: query.select, eq: query.eq, like: query.like, order: query.order, limit: query.limit, returns: query.returns }
        query.from.mockReturnValue(chain)
        for (const fn of [query.select, query.eq, query.like, query.order]) fn.mockReturnValue(chain)
        query.limit.mockReturnValue(chain)
        query.returns.mockResolvedValue({ data: [seasonLine()], error: null })
        expect(await getPlayerSeasonLines('player', 2026)).toHaveLength(1)
        expect(query.from).toHaveBeenCalledExactlyOnceWith('player_game_stats')
        expect(query.eq.mock.calls).toEqual([['player_id', 'player'], ['season_year', 2026]])
        expect(query.like).toHaveBeenCalledWith('nba_games.nba_game_id', '002%')
        expect(query.select.mock.calls[0][0]).toContain('status, game_time, started_at')
        expect(query.select.mock.calls[0][0]).toContain('is_home')
        expect(query.limit).toHaveBeenCalledWith(100)
    })

    it('makes every average equal the game log, including live stats and excluding DNPs', () => {
        const completed = seasonLine({ id: 'completed' })
        const live = seasonLine({ id: 'live', minutes_played: 12.3, points: 9, rebounds: 3, assists: 2,
            steals: 1, blocks: 0, turnovers: 1, three_pointers_made: 1, double_double: false,
            nba_games: { ...completed.nba_games, game_date: '2026-10-24', status: 'in_progress' } })
        const dnp = seasonLine({ id: 'dnp', did_not_play: true, points: 99 })
        const result = summarizePlayerSeason([completed, dnp, live], 'LAL', {
            points: 1, rebounds: 1.2, assists: 1.5, steals: 3, blocks: 3, turnovers: -1,
            three_pointers_made: 0.5, field_goals_made: 0.1, field_goals_attempted: -0.1,
            free_throws_made: 0.2, free_throws_attempted: -0.2, double_double: 4, triple_double: 7,
        })
        const games = result.games.filter(game => !game.didNotPlay)
        expect(result.games[0].gameId).toBe('live')
        expect(result.includesLive).toBe(true)
        expect(result.averages?.gamesPlayed).toBe(games.length)
        for (const [average, stat] of [
            ['avgPoints', 'points'], ['avgMinutesPlayed', 'minutes'], ['avgRebounds', 'rebounds'],
            ['avgAssists', 'assists'], ['avgSteals', 'steals'], ['avgBlocks', 'blocks'], ['avgTurnovers', 'turnovers'],
            ['avgThreePointersMade', 'threeMade'], ['avgFieldGoalsMade', 'fgMade'], ['avgFieldGoalsAttempted', 'fgAttempted'],
            ['avgFreeThrowsMade', 'ftMade'], ['avgFreeThrowsAttempted', 'ftAttempted'],
        ] as const) expect(result.averages?.[average]).toBe(games.reduce((sum, game) => sum + (game[stat] ?? 0), 0) / games.length)
        expect(result.fantasyPointsMap?.get('completed')).toBe(59.1)
        expect(result.fantasyPointsMap?.get('live')).toBe(17.1)
        expect(result.fantasyPointsMap?.get('dnp')).toBe(0)
        expect(result.avgFantasyPoints).toBe(games.reduce((sum, game) => sum + result.fantasyPointsMap!.get(game.gameId)!, 0) / games.length)
    })

    it.each(['InProgress', 'in_progress', 'inprogress'])('identifies the server live status %s', status => {
        const row = seasonLine()
        const result = summarizePlayerSeason([{ ...row, nba_games: { ...row.nba_games, status } }], 'LAL', { points: 1 })
        expect(result.includesLive).toBe(true)
        expect(result.games[0].live).toBe(true)
        expect(result.avgFantasyPoints).toBe(row.points)
    })

    it('does not invent averages when every stat line is a DNP', () => {
        const result = summarizePlayerSeason([seasonLine({ did_not_play: true })], 'LAL', null)
        expect(result.averages).toBeNull()
        expect(result.avgFantasyPoints).toBe(0)
        expect(result.fantasyPointsMap).toBeNull()
    })
})

it('preserves missing game minutes separately from played zero minutes', () => {
    const result = summarizePlayerSeason([seasonLine({ id: 'missing', minutes_played: null }), seasonLine({ id: 'zero', minutes_played: 0 })], 'LAL', null)
    expect(result.games.find(game => game.gameId === 'missing')?.minutes).toBeNull()
    expect(result.games.find(game => game.gameId === 'zero')?.minutes).toBe(0)
})
