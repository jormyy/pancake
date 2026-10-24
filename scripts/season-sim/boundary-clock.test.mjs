import assert from 'node:assert/strict'
import test from 'node:test'
import { boundaryDueAt, checkBoundaryWait } from './boundary-clock.mjs'

test('playoff grace waits for the daily production gate', () => {
  const finalizedAt = '2026-03-23T03:19:40Z'
  assert.equal(boundaryDueAt(finalizedAt), Date.parse('2026-03-25T13:00:00Z'))
  checkBoundaryWait({ finalizedAt, finalized: true, now: Date.parse('2026-03-25T09:00:00Z') })
  assert.throws(() => checkBoundaryWait({ finalizedAt, finalized: true, now: Date.parse('2026-03-25T13:00:00Z') }))
  assert.throws(() => checkBoundaryWait({ finalizedAt, finalized: false, now: Date.parse('2026-03-25T09:00:00Z') }))
})

test('the boundary clock follows DST and waits for tomorrow after the daily claim', () => {
  assert.equal(boundaryDueAt('2026-10-31T15:00:00Z'), Date.parse('2026-11-03T14:00:00Z'))
  assert.equal(boundaryDueAt('2026-03-06T14:00:00Z'), Date.parse('2026-03-09T13:00:00Z'))
})
