import assert from 'node:assert/strict'
import { test } from 'node:test'
import { virtualTimers } from './timers.mjs'

test('accelerated polling leaves enough real time for healthy database work', async () => {
  const timers = virtualTimers({ timeout: setTimeout, interval: setInterval, abortTimeout: ms => AbortSignal.timeout(ms) }, () => 20)
  const signal = timers.abortTimeout(100)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(signal.aborted, false)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(signal.aborted, true)
})

test('cadence accelerates but the outer wall-clock safety limit stays real', () => {
  const delays = []
  const timers = virtualTimers({ timeout: (_callback, ms) => delays.push(ms), interval: (_callback, ms) => delays.push(ms) }, () => 20)
  timers.timeout(() => {}, 20000)
  timers.interval(() => {}, 30000)
  timers.timeout(() => {}, 100000)
  timers.timeout(() => {}, 115000)
  assert.deepEqual(delays, [1000, 1500, 5000, 115000])
})
