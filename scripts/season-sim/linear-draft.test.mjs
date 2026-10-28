import assert from 'node:assert/strict'
import test from 'node:test'
import { rookiePickOrder } from './official-outcomes.mjs'
import { rookieOrder } from './post-oracle.mjs'

test('rookie order is linear by default and snake remains explicit', () => {
  const seed = ['a', 'b', 'c']
  for (let round = 1; round <= 3; round++) assert.deepEqual(rookiePickOrder(seed, round), seed)
  assert.deepEqual(rookiePickOrder(seed, 2, 'snake'), ['c', 'b', 'a'])
  assert.deepEqual(seed, ['a', 'b', 'c'])
  assert.throws(() => rookiePickOrder(seed, 0))
  assert.deepEqual(rookieOrder(['a', 'b', 'c'], [
    { member_id: 'a', week_number: 1, wins: 2, losses: 2, points_for: 300 },
    { member_id: 'b', week_number: 1, wins: 1, losses: 1, points_for: 200 },
  ]), ['b', 'a', 'c'])
})
