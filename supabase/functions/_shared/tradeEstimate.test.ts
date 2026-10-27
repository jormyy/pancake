import assert from 'node:assert/strict'
import { analyzeTradeEstimate, type TradeEstimateInputs } from './tradeEstimate.ts'

const observedAt = Date.parse('2025-02-10T12:00:00Z')
function fixture(): TradeEstimateInputs {
  return {
    leagueId: 'league', seasonId: 'season', seasonYear: 2025, teams: 10, rosterSize: 20, scoringSettings: { points: 1 }, faabBudget: 100,
    terms: [
      { fromMemberId: 'a', toMemberId: 'b', playerId: null, pickId: null, faabAmount: 10 },
      { fromMemberId: 'b', toMemberId: 'a', playerId: null, pickId: null, faabAmount: 20 },
    ],
    players: [], replacementPlayers: [], picks: [],
  }
}

Deno.test('frozen FAAB accounting is exact, stable, and reversible', () => {
  const input = fixture()
  const result = analyzeTradeEstimate(input, observedAt)
  assert.deepEqual(result.teams.map(team => [team.valuesSent, team.valuesReceived, team.impact]), [[10, 20, 10], [20, 10, -10]])
  assert.deepEqual(analyzeTradeEstimate(input, observedAt), result)
  input.terms = input.terms.map(term => ({ ...term, fromMemberId: term.toMemberId, toMemberId: term.fromMemberId }))
  assert.deepEqual(analyzeTradeEstimate(input, observedAt).teams.map(team => team.impact), [-10, 10])
})

Deno.test('known pick position and future-year discount use the frozen official team count', () => {
  const input = fixture()
  input.terms = [{ fromMemberId: 'a', toMemberId: 'b', playerId: null, pickId: 'pick', faabAmount: 0 }]
  input.picks = [{ id: 'pick', seasonYear: 2027, round: 1, slot: 1, ownerId: 'a', originalOwnerId: 'c', originalTeamName: 'Original' }]
  assert.equal(analyzeTradeEstimate(input, observedAt).assets[0].label, '2026 Round 1 · Original')
  assert.equal(analyzeTradeEstimate(input, observedAt).assets[0].values.overall, 716)
  input.picks[0].slot = null
  const unknown = analyzeTradeEstimate(input, observedAt).assets[0]
  assert.equal(unknown.values.overall, 557)
  assert.deepEqual(unknown.ranges.overall, { low: 397, high: 716 })
})

Deno.test('future and stale evidence is excluded without turning the player into zero value', () => {
  const input = fixture()
  input.terms = [{ fromMemberId: 'a', toMemberId: 'b', playerId: 'player', pickId: null, faabAmount: 0 }]
  input.players = [{ player_id: 'player', display_name: 'Player', ranking_fetched_at: '2026-01-01T00:00:00Z',
    projection_fetched_at: '2024-01-01T00:00:00Z', projection_source: 'sleeper', age: 22, five_year_rank: 1,
    three_year_rank: 1, rank_change: 0, injury_status: 'Out', avg_fantasy_points: null, projection_fantasy_points: 99,
    years_exp: 0, ranking_source: 'fixture' }]
  const result = analyzeTradeEstimate(input, observedAt)
  assert.ok(result.assets[0].values.overall > 0)
  assert.ok(result.missingInputs.includes('dynasty rank'))
  assert.ok(result.missingInputs.includes('projection'))
  assert.equal(result.assets[0].components.healthMultiplier, 0.88)
  input.players = []
  assert.throws(() => analyzeTradeEstimate(input, observedAt), /missing from the frozen/)
})
