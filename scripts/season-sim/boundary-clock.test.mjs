import assert from 'node:assert/strict'
import test from 'node:test'
import { boundaryDueAt, checkBoundaryWait } from './boundary-clock.mjs'

test('the end of a round waits for the daily production gate', () => {
  const lastGameDate = '2026-03-22'
  assert.equal(boundaryDueAt(lastGameDate), Date.parse('2026-03-23T13:00:00Z'))
  checkBoundaryWait({ lastGameDate, finalized: true, now: Date.parse('2026-03-23T09:00:00Z') })
  assert.throws(() => checkBoundaryWait({ lastGameDate, finalized: true, now: Date.parse('2026-03-23T13:00:00Z') }))
  assert.throws(() => checkBoundaryWait({ lastGameDate, finalized: false, now: Date.parse('2026-03-23T09:00:00Z') }))
})

test('the boundary clock follows DST and waits for tomorrow after the daily claim', () => {
  assert.equal(boundaryDueAt('2026-10-31'), Date.parse('2026-11-01T14:00:00Z'))
  assert.equal(boundaryDueAt('2026-03-07'), Date.parse('2026-03-08T13:00:00Z'))
})
