import assert from 'node:assert/strict'
import test from 'node:test'
import { rookiePickOrder } from './official-outcomes.mjs'

test('rookie order is linear by default and snake remains explicit', () => {
  const seed = ['a', 'b', 'c']
  for (let round = 1; round <= 3; round++) assert.deepEqual(rookiePickOrder(seed, round), seed)
  assert.deepEqual(rookiePickOrder(seed, 2, 'snake'), ['c', 'b', 'a'])
  assert.deepEqual(seed, ['a', 'b', 'c'])
  assert.throws(() => rookiePickOrder(seed, 0))
})
