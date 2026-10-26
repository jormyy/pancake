import assert from 'node:assert/strict'
import { computeForecast, type ForecastContext } from './compute.ts'

function fixture(): ForecastContext {
  return {
    matchupId: 'matchup', observedAt: '2025-02-10T12:00:00Z', today: '2025-02-10', weekEnd: '2025-02-16', isFinalized: false,
    teams: [{ memberId: 'home', currentPoints: 100 }, { memberId: 'away', currentPoints: 90 }],
    roster: [
      { member_id: 'home', player_id: 'guard', nba_team: 'BOS', eligible_positions: ['PG'], injury_status: null, is_on_ir: false, is_on_taxi: false },
      { member_id: 'home', player_id: 'bench', nba_team: 'BOS', eligible_positions: ['PG'], injury_status: null, is_on_ir: false, is_on_taxi: false },
      { member_id: 'away', player_id: 'center', nba_team: 'NYK', eligible_positions: ['C'], injury_status: null, is_on_ir: false, is_on_taxi: false },
    ],
    games: [{ id: 'game', game_date: '2025-02-10', home_team: 'BOS', away_team: 'NYK', status: 'Scheduled',
      game_time: '2025-02-11T00:00:00Z', started_at: null, live_scoreboard_elapsed_seconds: null, live_stats_elapsed_seconds: null }],
    history: ['guard', 'bench', 'center'].map(player_id => ({ player_id, scores: [10, 20, 30, 40, 50] })),
    projections: [['guard', 30], ['bench', 50], ['center', 40]].map(([player, points]) => ({
      requested_date: '2025-02-10', player_id: String(player), projection_fantasy_points: Number(points),
      projection_source_label: 'Fixture', projection_fetched_at: '2025-02-10T10:00:00Z', projection_date: '2025-02-10', projection_is_fresh: true,
    })),
    lineups: [
      { member_id: 'home', player_id: 'guard', game_date: '2025-02-10', slot_type: 'PG', is_auto_set: false },
      { member_id: 'home', player_id: 'bench', game_date: '2025-02-10', slot_type: 'BE', is_auto_set: false },
      { member_id: 'away', player_id: 'center', game_date: '2025-02-10', slot_type: 'C', is_auto_set: false },
    ],
    templates: [{ slot_type: 'PG', slot_count: 1 }, { slot_type: 'C', slot_count: 1 }], automaticMembers: [], previous: null,
  }
}

Deno.test('manual starters control the forecast; bench, taxi and IR cannot leak into automatic slots', () => {
  const context = fixture()
  assert.deepEqual(computeForecast(context).teams.map(team => team.projectedFinal), [130, 130])
  context.automaticMembers = ['home']
  assert.deepEqual(computeForecast(context).teams.map(team => team.projectedFinal), [150, 130])
  context.roster[1].is_on_taxi = true
  assert.deepEqual(computeForecast(context).teams.map(team => team.projectedFinal), [130, 130])
  context.roster[1].is_on_taxi = false
  context.roster[1].is_on_ir = true
  assert.deepEqual(computeForecast(context).teams.map(team => team.projectedFinal), [130, 130])
})

Deno.test('automatic lineups preserve locked players and live points use only remaining game time', () => {
  const context = fixture()
  context.previous = computeForecast(context)
  context.observedAt = '2025-02-11T01:00:00Z'
  context.automaticMembers = ['home', 'away']
  context.games[0].status = 'InProgress'
  context.games[0].live_scoreboard_elapsed_seconds = 1440
  context.projections.forEach(row => { row.projection_fantasy_points = 1000 })
  const result = computeForecast(context)
  assert.deepEqual(result.teams.map(team => team.projectedFinal), [115, 110])
  assert.deepEqual(result.games.map(game => game.playerId), ['guard', 'center'])
  context.games[0].status = 'Final'
  assert.deepEqual(computeForecast(context).teams.map(team => team.projectedFinal), [100, 90])
})

Deno.test('future, stale, mismatched and absent inputs never become calculated win odds', () => {
  for (const change of [
    (context: ForecastContext) => { context.projections[0].projection_fetched_at = '2025-02-12T00:00:00Z' },
    (context: ForecastContext) => { context.projections[0].projection_is_fresh = false },
    (context: ForecastContext) => { context.projections[0].projection_date = '2025-02-12' },
    (context: ForecastContext) => { context.history = [] },
    (context: ForecastContext) => { context.games[0].status = 'InProgress' },
  ]) {
    const context = fixture()
    change(context)
    const result = computeForecast(context)
    assert.notEqual(result.status, 'available')
    assert.equal(result.teams[0].winProbability, null)
  }
})

Deno.test('known unavailable players cannot be selected by automatic lineups', () => {
  const context = fixture()
  context.automaticMembers = ['home']
  context.roster[1].injury_status = 'Out'
  assert.deepEqual(computeForecast(context).games.map(game => game.playerId), ['guard', 'center'])
  context.roster[0].injury_status = 'IR'
  assert.deepEqual(computeForecast(context).teams.map(team => team.remainingGames), [0, 1])
})
