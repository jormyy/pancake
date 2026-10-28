import { expect, it, vi } from 'vitest'
import type { MatchupForecast } from '@/hooks/use-matchup-forecast'

const { computeForecast } = await vi.importActual<{ computeForecast: (context: ReturnType<typeof fixture>) => Pick<MatchupForecast, 'status' | 'teams' | 'games' | 'missingInputs'> }>('../supabase/functions/matchup-forecast/compute.ts')

function fixture() {
    return {
        matchupId: 'matchup', observedAt: '2026-10-27T22:16:17Z', today: '2026-10-27', weekEnd: '2026-11-01', isFinalized: false,
        teams: [{ memberId: 'opponent', currentPoints: 359 }, { memberId: 'justin', currentPoints: 366 }],
        roster: [{ member_id: 'justin', player_id: 'missing-provider-player', nba_team: 'MIL', eligible_positions: ['PG', 'SG'], injury_status: null, is_on_ir: false, is_on_taxi: false }],
        games: [{ id: 'game', game_date: '2026-10-31', home_team: 'MIL', away_team: 'CHI', status: 'Scheduled', game_time: '2026-10-31T23:00:00Z', started_at: null, live_scoreboard_elapsed_seconds: null, live_stats_elapsed_seconds: null as number | null }],
        history: [{ player_id: 'missing-provider-player', scores: [10, 20, 30, 40, 50] }],
        projections: [{ requested_date: '2026-10-31', player_id: 'missing-provider-player', projection_fantasy_points: null as number | null, projection_source_label: null as string | null, projection_fetched_at: null as string | null, projection_date: null as string | null, projection_is_fresh: false }],
        lineups: [{ member_id: 'justin', player_id: 'missing-provider-player', game_date: '2026-10-31', slot_type: 'UTIL', is_auto_set: true }],
        templates: [{ slot_type: 'UTIL', slot_count: 1 }], automaticMembers: ['justin'], previous: null as Pick<MatchupForecast, 'games'> | null,
    }
}

it('uses completed scoring history when a starter has no provider projection', () => {
    const forecast = computeForecast(fixture())
    expect(forecast.status).toBe('available')
    expect(forecast.teams[1]).toMatchObject({ projectedFinal: 396, remainingGames: 1, coveredGames: 1 })
    expect(forecast.teams[1].winProbability).toBeGreaterThan(0.5)
    expect(forecast.missingInputs).toEqual([])
    expect(forecast.games[0]).toMatchObject({ projection: 30, source: 'Recent games', sourceAt: null })
})

it('keeps missing inputs explicit without five completed observations', () => {
    const context = fixture()
    context.history[0].scores = [10, 20, 30, 40]
    const forecast = computeForecast(context)
    expect(forecast.teams[1].projectedFinal).toBeNull()
    expect(forecast.teams[1].winProbability).toBeNull()
    expect(forecast.status).not.toBe('available')
})

it('prefers a fresh provider projection over the historical fallback, including zero', () => {
    const context = fixture()
    context.projections[0] = { ...context.projections[0], projection_date: '2026-10-31', projection_is_fresh: true, projection_fantasy_points: 0, projection_source_label: 'Provider' }
    expect(computeForecast(context).games[0]).toMatchObject({ projection: 0, source: 'Provider' })
})

it('keeps the pregame fallback fixed after tipoff', () => {
    const context = fixture()
    context.previous = computeForecast(context)
    context.observedAt = '2026-11-01T00:00:00Z'
    context.games[0].status = 'InProgress'
    context.games[0].live_stats_elapsed_seconds = 1440
    context.history[0].scores = [100, 200, 300, 400, 500]
    const forecast = computeForecast(context)
    expect(forecast.games[0]).toMatchObject({ projection: 30, source: 'Recent games', remainingFraction: 0.5 })
    expect(forecast.teams[1].projectedFinal).toBe(381)
})

it.each(['stale', 'future', 'wrong-date'])('does not use a %s provider estimate as a fresh projection', kind => {
    const context = fixture()
    context.projections[0] = { ...context.projections[0], projection_date: kind === 'wrong-date' ? '2026-11-02' : '2026-10-31', projection_is_fresh: kind !== 'stale', projection_fantasy_points: 100, projection_fetched_at: kind === 'future' ? '2026-11-02T00:00:00Z' : null }
    expect(computeForecast(context).teams[1].projectedFinal).toBeNull()
})
