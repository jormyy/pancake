import assert from 'node:assert/strict'
import test from 'node:test'
import { tableRows } from './prepare-two.mjs'

test('raw table columns remain keyed by their published headers', () => {
  assert.deepEqual(tableRows({ resultSets: [{ headers: ['PERSON_ID', 'PLAYER_NAME'], rowSet: [[1, 'Real Rookie']] }] }), [{ PERSON_ID: 1, PLAYER_NAME: 'Real Rookie' }])
  assert.throws(() => tableRows({}))
})
