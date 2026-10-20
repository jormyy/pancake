import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scheduleObservation } from './schedule-view.mjs'

const game = { id: 'real-makeup', date: '2026-01-25', time: '2026-01-25T22:30:00Z', home: 'MIN', away: 'GSW' }
const postponed = { date: '2026-01-24', time: '2026-01-25T01:00:00Z' }
const bounds = { start: Date.parse('2026-01-25T22:40:00Z'), end: Date.parse('2026-01-26T01:00:00Z') }

test('the daily source policy publishes postponement before the original tipoff', () => {
  const row = scheduleObservation(game, postponed, bounds, Date.parse('2026-01-24T14:00:00Z'))
  assert.equal(row.gameDateEst, postponed.date)
  assert.equal(row.gameStatusText, 'Postponed')
  assert.equal(row.gameStatus, 1)
})

test('the next Eastern morning publishes a next-day makeup before its real tipoff', () => {
  const row = scheduleObservation(game, postponed, bounds, Date.parse('2026-01-25T14:00:00Z'))
  assert.equal(row.gameDateEst, game.date)
  assert.equal(row.gameDateTimeUTC, game.time)
  assert.equal(row.gameStatusText, 'Scheduled')
  const before = scheduleObservation(game, postponed, bounds, Date.parse('2026-01-23T14:00:00Z'))
  assert.equal(before.gameDateEst, postponed.date)
  assert.equal(before.gameStatusText, 'Scheduled')
})
