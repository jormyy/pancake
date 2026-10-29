import { expect, it, vi } from 'vitest'
import type { MatchupForecast } from '@/hooks/use-matchup-forecast'

const { computeForecast } = await vi.importActual<{ computeForecast: (context: ReturnType<typeof fixture>) => Pick<MatchupForecast, 'status' | 'teams' | 'games' | 'missingInputs'> }>('../supabase/functions/matchup-forecast/compute.ts')

function fixture() {
    return {
        matchupId: 'matchup', observedAt: '2026-10-27T22:16:17Z', today: '2026-10-27', weekEnd: '2026-11-01', isFinalized: false,
        teams: [{ memberId: 'opponent', currentPoints: 359 }, { memberId: 'justin', currentPoints: 366 }],
        roster: [{ member_id: 'justin', player_id: 'missing-provider-player', nba_team: 'MIL', eligible_positions: ['PG', 'SG'], injury_status: null, is_on_ir: false, is_on_taxi: false }],
        games: [{ id: 'game', game_date: '2026-10-31', home_team: 'MIL', away_team: 'CHI', status: 'Scheduled', game_time: '2026-10-31T23:00:00Z', started_at: null, live_scoreboard_elapsed_seconds: null, live_stats_elapsed_seconds: null as number | null }],
        seasonAverages: [{ player_id: 'missing-provider-player', avg_fantasy_points: 24 }],
        history: [{ player_id: 'missing-provider-player', scores: [10, 20, 30, 40, 50] }],
        projections: [{ requested_date: '2026-10-31', player_id: 'missing-provider-player', projection_fantasy_points: null as number | null, projection_source_label: null as string | null, projection_fetched_at: null as string | null, projection_date: null as string | null, projection_is_fresh: false }],
        lineups: [{ member_id: 'justin', player_id: 'missing-provider-player', game_date: '2026-10-31', slot_type: 'UTIL', is_auto_set: true }],
        templates: [{ slot_type: 'UTIL', slot_count: 1 }], automaticMembers: ['justin'], previous: null as Pick<MatchupForecast, 'games'> | null,
    }
}

it('substitutes the season average before tipoff', () => {
    const forecast = computeForecast(fixture())
    expect(forecast.status).toBe('limited')
    expect(forecast.teams[1]).toMatchObject({ projectedFinal: 390, remainingGames: 1, coveredGames: 1 })
    expect(forecast.teams.every(team => Number.isFinite(team.winProbability))).toBe(true)
    expect(forecast.games[0]).toMatchObject({ projection: 24, source: 'Season average estimate' })
})

it('substitutes a missing frozen projection during a live game', () => {
    const context = fixture()
    context.observedAt = '2026-11-01T00:00:00Z'
    context.games[0].status = 'InProgress'
    context.games[0].live_stats_elapsed_seconds = 1440
    context.previous = { games: [{ gameId: 'game', playerId: 'missing-provider-player', memberId: 'justin',
        date: '2026-10-31', projection: null, source: null, sourceAt: null, remainingFraction: 0.5 }] }
    const forecast = computeForecast(context)
    expect(forecast.teams[1].projectedFinal).toBe(381)
    expect(forecast.teams.every(team => Number.isFinite(team.winProbability))).toBe(true)
    expect(forecast.status).toBe('limited')
    context.previous = null
    expect(computeForecast(context).teams[1].projectedFinal).toBe(381)
})

it('substitutes zero without a season average or scoring history', () => {
    const context = fixture()
    context.seasonAverages = []
    context.history = []
    const forecast = computeForecast(context)
    expect(forecast.teams[1].projectedFinal).toBe(366)
    expect(forecast.teams.every(team => Number.isFinite(team.winProbability))).toBe(true)
    expect(forecast.status).toBe('limited')
    expect(forecast.games[0]).toMatchObject({ projection: 0, source: 'Zero estimate' })
})

it('combines a provider projection with a substituted player-game', () => {
    const context = fixture()
    context.roster.push({ ...context.roster[0], player_id: 'covered-player', member_id: 'opponent' })
    context.lineups.push({ ...context.lineups[0], player_id: 'covered-player', member_id: 'opponent' })
    context.projections.push({ ...context.projections[0], player_id: 'covered-player', projection_fantasy_points: 40,
        projection_date: '2026-10-31', projection_is_fresh: true, projection_source_label: 'Provider' })
    const forecast = computeForecast(context)
    expect(forecast.teams.map(team => team.projectedFinal)).toEqual([399, 390])
    expect(forecast.teams.every(team => Number.isFinite(team.winProbability))).toBe(true)
    expect(forecast.games.map(game => game.source)).toEqual(['Season average estimate', 'Provider'])
    expect(forecast.status).toBe('limited')
})

it('prefers a fresh provider projection, including zero', () => {
    const context = fixture()
    context.projections[0] = { ...context.projections[0], projection_date: '2026-10-31', projection_is_fresh: true, projection_fantasy_points: 0, projection_source_label: 'Provider' }
    expect(computeForecast(context).games[0]).toMatchObject({ projection: 0, source: 'Provider' })
})

it('keeps the pregame estimate fixed after tipoff and records the substitution', () => {
    const context = fixture()
    context.previous = computeForecast(context)
    context.observedAt = '2026-11-01T00:00:00Z'
    context.games[0].status = 'InProgress'
    context.games[0].live_stats_elapsed_seconds = 1440
    context.seasonAverages[0].avg_fantasy_points = 100
    const forecast = computeForecast(context)
    expect(forecast.games[0]).toMatchObject({ projection: 24, source: 'Season average estimate', remainingFraction: 0.5 })
    expect(forecast.teams[1].projectedFinal).toBe(378)
    expect(forecast.status).toBe('limited')
})

it.each(['stale', 'future', 'wrong-date'])('substitutes the season average for a %s provider estimate', kind => {
    const context = fixture()
    context.projections[0] = { ...context.projections[0], projection_date: kind === 'wrong-date' ? '2026-11-02' : '2026-10-31', projection_is_fresh: kind !== 'stale', projection_fantasy_points: 100, projection_fetched_at: kind === 'future' ? '2026-11-02T00:00:00Z' : null }
    expect(computeForecast(context).teams[1].projectedFinal).toBe(390)
})

it('recovers Justin’s live player-game from the backup-shaped fixture', async () => {
    const { default: backup } = await import('./fixtures/matchup-forecast-justin.json')
    const context = structuredClone(backup) as unknown as ReturnType<typeof fixture>
    context.observedAt = '2026-10-29T01:11:00Z'
    context.today = '2026-10-28'
    const playerId = 'f28f3bf6-7490-446a-afe1-f7ce09d81b87'
    const gameId = 'd54a84ef-8f3b-4d96-8843-ff2b66808d59'
    const game = context.games.find(row => row.id === gameId)!
    game.status = 'InProgress'
    game.live_stats_elapsed_seconds = 1353.6
    context.automaticMembers = []
    context.lineups = context.lineups.filter(row => row.player_id !== playerId || row.game_date !== game.game_date)
    context.lineups.push({ member_id: '6d9faceb-6d4a-479b-ace7-ac65a73fc982', player_id: playerId, game_date: game.game_date, slot_type: 'UTIL', is_auto_set: false })
    context.previous = { games: context.previous?.games.filter(row => row.playerId !== playerId || row.gameId !== gameId) ?? [] }
    context.projections = context.projections.filter(row => row.player_id !== playerId || row.requested_date !== game.game_date)
    context.projections.push({ player_id: playerId, requested_date: game.game_date, projection_date: game.game_date,
        projection_fantasy_points: 16.43, projection_source_label: 'Sleeper (RotoWire)', projection_fetched_at: '2026-10-28T22:00:00Z', projection_is_fresh: true })
    const forecast = computeForecast(context)
    expect(forecast.games.find(row => row.playerId === playerId && row.gameId === gameId)).toMatchObject({ projection: 16.43, remainingFraction: 0.53 })
    expect(forecast.teams.every(team => Number.isFinite(team.projectedFinal) && Number.isFinite(team.winProbability))).toBe(true)
    expect(forecast.status).toBe('limited')
    expect(forecast.missingInputs).toContain(`Projection substituted: ${playerId}:${gameId}`)
})
