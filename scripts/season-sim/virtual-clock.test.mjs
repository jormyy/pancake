import assert from 'node:assert/strict'
import test from 'node:test'
import { clockTime, virtualDate } from './virtual-clock.mjs'

test('clock pauses and advances from one shared anchor', () => {
  assert.equal(clockTime({ simMs: 1000, realMs: 5000, rate: 0 }, 9000), 1000)
  assert.equal(clockTime({ simMs: 1000, realMs: 5000, rate: 20 }, 6000), 21000)
  assert.throws(() => clockTime({ simMs: 1000, realMs: 5000, rate: -1 }, 6000))
  assert.throws(() => clockTime({ simMs: Infinity, realMs: 5000, rate: 1 }, 6000))
})

test('virtual Date preserves explicit dates and follows clock changes', () => {
  const state = { simMs: Date.parse('2025-10-21T23:30Z'), realMs: Date.now(), rate: 0 }
  const ClockDate = virtualDate(Date, () => state)
  assert.equal(new ClockDate().toISOString(), '2025-10-21T23:30:00.000Z')
  assert.equal(ClockDate.now(), state.simMs)
  assert.equal(new ClockDate('2026-04-12T12:00Z').toISOString(), '2026-04-12T12:00:00.000Z')
  assert.equal(ClockDate.parse('2026-04-12T12:00Z'), Date.parse('2026-04-12T12:00Z'))
  assert.equal(new ClockDate() instanceof Date, true)
  state.simMs += 60000
  assert.equal(ClockDate.now(), state.simMs)
  assert.equal(ClockDate(), new Date(state.simMs).toString())
})

test('slow live work cannot advance the shared clock past the next dispatch', () => {
  const state = { simMs: Date.parse('2026-02-28T02:25:59.999Z'), realMs: 1000, rate: 20, capMs: Date.parse('2026-02-28T02:29:00Z') }
  assert.equal(clockTime(state, 2000), state.simMs + 20000)
  assert.equal(clockTime(state, 14000), state.capMs)
  assert.equal(clockTime(state, 61000), state.capMs)
  assert.throws(() => clockTime({ ...state, capMs: state.simMs - 1 }, 2000), /ceiling/)
  assert.throws(() => clockTime({ ...state, capMs: NaN }, 2000), /ceiling/)
})
