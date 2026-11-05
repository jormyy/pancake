import test from 'node:test'
import assert from 'node:assert/strict'
import { summary, sensitivity, noise } from './common.mjs'
import { hotWorkloads } from './hot.mjs'

test('quantiles retain tail cost and reject invalid measurements', () => {
  assert.deepEqual(summary([5, 1, 3, 2, 100]), { n: 5, p50: 3, p95: 100, min: 1, max: 100 })
  assert.throws(() => summary([]))
  assert.throws(() => summary([NaN]))
})
test('sensitivity rejects overlapping ranges and detects a real slowdown', () => {
  assert.equal(sensitivity([8, 9, 10, 11, 12], [9, 10, 11, 12, 13]).detected, false)
  assert.equal(sensitivity([8, 9, 10, 11, 12], [30, 31, 32, 33, 34]).detected, true)
})
test('noise reports regression and improvement with units preserved', () => {
  assert.deepEqual(noise(12, 10), { previous: 10, delta: 2, percent: (12 / 10 - 1) * 100 })
  assert.equal(noise(8, 10).delta, -2)
  assert.equal(noise(1, undefined), null)
})
test('hot-loop fixtures exercise populated outputs and reject no work', async () => {
  for (const item of await hotWorkloads()) {
    const value = item.run()
    assert.ok(item.check(value), item.name)
    assert.ok(item.consume(value) > 0, item.name)
    assert.equal(item.check({ length: 0, matchups: [], stats: {}, teams: [], assets: [] }), false)
  }
})
