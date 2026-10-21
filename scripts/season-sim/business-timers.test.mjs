import assert from 'node:assert/strict'
import test from 'node:test'
import { businessTimers } from './business-timers.mjs'

test('business timers wait for the driver clock and cancel without a later callback', () => {
  const callbacks = new Map(), owner = { waiters: new Set() }
  let clock = 0, sequence = 0, calls = 0
  const register = callback => { callbacks.set(++sequence, callback); return sequence }
  const timers = businessTimers({ timeout: register, interval: register, clear: id => callbacks.delete(id), now: () => clock, context: () => owner })
  const wake = timers.timeout(() => calls++, 20000)
  assert.equal(timers.next(), 20000)
  callbacks.get(wake)()
  assert.equal(calls, 0)
  assert.equal(owner.waiters.size, 1)
  clock = 20000
  callbacks.get(wake)()
  assert.equal(calls, 1)
  assert.equal(owner.waiters.size, 0)
  const cancelled = timers.timeout(() => calls++, 20000)
  timers.clear(cancelled)
  assert.ok(!callbacks.has(cancelled))
  assert.equal(timers.next(), null)
  assert.equal(calls, 1)
  const controller = new AbortController()
  const deadline = timers.timeout(() => controller.abort(), 5000)
  assert.equal(timers.next(), null)
  assert.ok(callbacks.has(deadline))
})

test('fractional retry delays round up to a representable business millisecond', () => {
  const timers = businessTimers({ timeout: () => 1, interval: () => 1, clear: () => {}, now: () => 1000, context: () => ({ waiters: new Set() }) })
  timers.timeout(() => {}, 432.8425)
  assert.equal(timers.next(), 1433)
})

test('health exposes interval deadlines without counting them as worker sleeps',()=>{
  const owner={waiters:new Set()}
  let sequence=0
  const timers=businessTimers({timeout:()=>++sequence,interval:()=>++sequence,clear:()=>{},now:()=>1000,context:()=>owner})
  timers.interval(()=>{},15000)
  timers.timeout(()=>{},20000)
  assert.equal(owner.waiters.size,1)
  assert.deepEqual(timers.inspect(owner).map(row=>row.kind),['business-interval','business-sleep'])
  assert.equal(timers.next(),16000)
})
