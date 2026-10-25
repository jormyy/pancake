import assert from 'node:assert/strict'
import test from 'node:test'
import { retainedChampionCursor } from './retained-state.mjs'

const input = {
  snapshot: { cursor: { context: { leagueSeasonId: 'old', waiverScenarios: [{ name: 'earlier', checked: true, checkedAt: '2026-03-19T07:00:00Z', expected: { priorities: { a: 1 }, budgets: { a: 100 } } }] }, verifiedWeeks: [22] } },
  retained: { champion: { passed: true, matchupId: 'final', memberId: 'winner' }, leagueSeasonId: 'old', waivers: [{ name: 'pending', checked: false }], days: [1, 2], actions: { tradeDeadline: { pendingTrade: 'trade' } } },
  clock: { rate: 0, simMs: Date.parse('2026-04-13T14:00:00Z') }, currentSeason: 'old',
  final: { id: 'final', is_finalized: true, winner_member_id: 'winner', finalized_at: '2026-04-13T04:08:00Z' },
}

test('retained champion cursor keeps old checked waivers and newly submitted pending claims', () => {
  const cursor = retainedChampionCursor(input)
  assert.deepEqual(cursor.context.waiverScenarios.map(row => row.name), ['earlier', 'pending'])
  assert.equal(cursor.clock, input.clock.simMs)
  assert.deepEqual(cursor.actions, input.retained.actions)
  assert.deepEqual(cursor.verifiedWeeks, [22])
  cursor.context.waiverScenarios.pop()
  assert.equal(input.snapshot.cursor.context.waiverScenarios.length, 1)
})

test('retained champion recovery refuses mismatched seasons, champions and clocks', () => {
  const corruptions = [
    value => { value.currentSeason = 'new' },
    value => { value.retained.champion.passed = false },
    value => { value.final.id = 'different' },
    value => { value.final.winner_member_id = 'loser' },
    value => { value.final.is_finalized = false },
    value => { value.clock.rate = 1 },
    value => { value.clock.simMs = 0 },
  ]
  for (const corrupt of corruptions) {
    const value = structuredClone(input)
    corrupt(value)
    assert.throws(() => retainedChampionCursor(value))
  }
})

test('post-rollover recovery requires the recorded new season and keeps the prior champion', () => {
  const value = structuredClone(input)
  value.stage = 'post-rollover'
  value.currentSeason = 'new'
  value.retained.rolloverRecovery = { season: 'new' }
  const cursor = retainedChampionCursor(value)
  assert.equal(cursor.context.leagueSeasonId, 'new')
  assert.equal(cursor.context.previousSeasonId, 'old')
  assert.equal(cursor.context.previousChampionId, 'final')
  value.currentSeason = 'unexpected'
  assert.throws(() => retainedChampionCursor(value))
})
