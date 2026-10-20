import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertLiveCoverage } from './invariants.mjs'

test('coverage refuses missing live data, missing finals and absent dense quarters', () => {
  const games = [{ id: 'a' }]
  const coverage = { games: { a: { finalRaw: 1, scoreboard: 1, live: /** @type {Record<string, number>} */ ({ '1:PT10M00S': 1, '2:PT10M00S': 2, '3:PT10M00S': 3, '4:PT10M00S': 4 }) } } }
  const plan = { minimumSnapshots: 4, requiredPeriods: [1, 2, 3, 4] }
  assert.equal(assertLiveCoverage(coverage, games, plan).checks, 7)
  const missing = structuredClone(coverage)
  missing.games.a.live = {}
  assert.throws(() => assertLiveCoverage(missing, games, plan), /live snapshots/)
  const final = structuredClone(coverage)
  final.games.a.finalRaw = 0
  assert.throws(() => assertLiveCoverage(final, games, plan), /official raw final/)
  const quarter = structuredClone(coverage)
  delete quarter.games.a.live['3:PT10M00S']
  quarter.games.a.live['4:PT09M00S'] = 5
  assert.throws(() => assertLiveCoverage(quarter, games, plan), /quarter 3/)
})
