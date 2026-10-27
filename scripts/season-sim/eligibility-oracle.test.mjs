import assert from 'node:assert/strict'
import test from 'node:test'
import { withHistoricalEligibility } from './eligibility-oracle.mjs'

const stats = [{ player_id: 'p', lineup_date: '2025-02-10', game_time: '2025-02-11T00:00:00Z', position: 'C', eligible_positions: ['C'] }]
const saved = { observedAt: '2025-02-10T12:00:00Z', players: new Map([['p', { position: 'PF', eligible_positions: ['PF'] }]]) }

test('later position changes cannot rewrite historical scoring eligibility', () => {
  const result = withHistoricalEligibility(stats, new Map([['2025-02-10', saved]]))
  assert.deepEqual(result[0].eligible_positions, ['PF'])
  assert.deepEqual(stats[0].eligible_positions, ['C'])
})

test('missing and post-tipoff eligibility cannot pass as historical evidence', () => {
  assert.throws(() => withHistoricalEligibility(stats, new Map()), /exists/)
  assert.throws(() => withHistoricalEligibility(stats, new Map([['2025-02-10', { ...saved, observedAt: '2025-02-11T00:00:00Z' }]])), /before game/)
  assert.throws(() => withHistoricalEligibility(stats, new Map([['2025-02-10', { ...saved, players: new Map() }]])), /retained/)
})
