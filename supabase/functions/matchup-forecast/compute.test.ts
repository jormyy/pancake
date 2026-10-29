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

Deno.test('future, stale, mismatched and absent inputs keep numeric limited estimates', () => {
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
    assert.ok(result.teams.every(team => Number.isFinite(team.winProbability)))
    assert.ok(result.teams.every(team => Number.isFinite(team.projectedFinal)))
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

Deno.test('missing projections use averages before tipoff, recent games in progress, and zero without either', () => {
  for (const scenario of ['pregame', 'live', 'zero', 'mixed']) {
    const context = fixture()
    context.seasonAverages = [{ player_id: 'guard', avg_fantasy_points: 24 }, { player_id: 'center', avg_fantasy_points: 20 }]
    context.projections = scenario === 'mixed' ? context.projections.filter(row => row.player_id === 'center') : []
    if (scenario === 'live') {
      context.games[0].status = 'InProgress'
      context.games[0].live_stats_elapsed_seconds = 1440
    }
    if (scenario === 'zero') { context.seasonAverages = []; context.history = [] }
    const result = computeForecast(context)
    assert.equal(result.status, 'limited')
    assert.deepEqual(result.teams.map(team => team.projectedFinal), scenario === 'live' ? [115, 105]
      : scenario === 'zero' ? [100, 90] : scenario === 'mixed' ? [124, 130] : [124, 110])
    assert.ok(result.teams.every(team => Number.isFinite(team.winProbability)))
    assert.equal(result.games.filter(game => game.source?.endsWith('estimate')).length, scenario === 'mixed' ? 1 : scenario === 'live' ? 0 : 2)
  }
})

Deno.test('a started game recovers a fresh projection and freezes it on later reads', () => {
  const context = fixture()
  context.games[0].status = 'InProgress'
  context.games[0].live_stats_elapsed_seconds = 1440
  const result = computeForecast(context)
  assert.deepEqual(result.teams.map(team => team.projectedFinal), [115, 110])
  assert.equal(result.status, 'limited')
  assert.ok(result.missingInputs.includes('Projection substituted: guard:game'))
  context.previous = result
  context.projections.forEach(row => { row.projection_fantasy_points = 1000 })
  const next = computeForecast(context)
  assert.deepEqual(next.teams.map(team => team.projectedFinal), [115, 110])
  assert.equal(next.status, 'limited')
})

Deno.test('a started game without a frozen value or row uses recent games, then zero', () => {
  const context = fixture()
  context.games[0].status = 'InProgress'
  context.games[0].live_stats_elapsed_seconds = 1440
  context.projections = []
  const recent = computeForecast(context)
  assert.deepEqual(recent.teams.map(team => team.projectedFinal), [115, 105])
  context.previous = recent
  context.history.forEach(row => { row.scores = [100] })
  assert.deepEqual(computeForecast(context).teams.map(team => team.projectedFinal), [115, 105])
  context.previous = null
  assert.deepEqual(computeForecast(context).teams.map(team => team.projectedFinal), [150, 140])
  context.history = []
  const result = computeForecast(context)
  assert.deepEqual(result.teams.map(team => team.projectedFinal), [100, 90])
  assert.ok(result.teams.every(team => Number.isFinite(team.winProbability)))
  assert.equal(result.status, 'limited')
})
