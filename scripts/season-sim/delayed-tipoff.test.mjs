import assert from 'node:assert/strict'
import test from 'node:test'
import { checkFirstQuarterPolling } from './delayed-tipoff.mjs'

test('first-quarter polling refuses an empty or wholly unpolled quarter', () => {
  assert.throws(() => checkFirstQuarterPolling([]), /fixture must supply/)
  assert.throws(() => checkFirstQuarterPolling([{ work: 0 }, { work: 0 }]), /must reach the first quarter/)
  assert.doesNotThrow(() => checkFirstQuarterPolling([{ work: 0 }, { work: 1 }]))
})
