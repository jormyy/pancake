import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coverWindows, dayClass, canOverlapDispatch } from './planner.mjs'

test('concurrent cron delivery reserves enough time for two queued live workers', () => {
  const event = { at: Date.parse('2025-10-28T23:26:59.999Z') }
  assert.equal(canOverlapDispatch(event, { at: Date.parse('2025-10-28T23:29:00Z') }), false)
  assert.equal(canOverlapDispatch(event, { at: event.at + 360000 }), true)
  assert.equal(canOverlapDispatch(event), true)
})

test('shared live checkpoints cover every input window and protect pre-tip dispatch', () => {
  const windows = [
    { gameId: 'a', period: 1, start: 1000000, end: 1600000 },
    { gameId: 'b', period: 1, start: 1200000, end: 1900000 },
    { gameId: 'c', period: 1, start: 2400000, end: 2700000 },
  ]
  const events = coverWindows(windows, [1800000])
  assert.equal(events.length, 2)
  for (const window of windows) assert.ok(events.some(event => event.at >= window.start && event.at <= window.end))
  assert.ok(events.every(event => event.at < 1620000 || event.at > 1920000))
  assert.throws(() => coverWindows([{ start: 1700000, end: 1800000 }], [1800000]), /checkpoint|window/)
})

test('dense classes cover each month, postponements, faults, skipped week and playoffs', () => {
  for (const month of ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']) assert.notEqual(dayClass(`${month}-07`), 'standard')
  for (const date of ['2025-10-22', '2026-01-08', '2026-01-25', '2026-01-29', '2026-02-15', '2026-03-18', '2026-03-31', '2026-04-12']) assert.notEqual(dayClass(date), 'standard')
  assert.equal(dayClass('2025-11-10'), dayClass('2025-11-10'))
})

/** @typedef {{ actionNumber: number, orderNumber: number, period: number, timeActual: string, actionType?: string, subType?: string }} PlannedAction */

test('a late game gets its first snapshot before the Eastern scoreboard date changes', async () => {
  const { planDay } = await import('./planner.mjs')
  /** @type {PlannedAction[]} */
  const actions = Array.from({ length: 100 }, (_, index) => ({ actionNumber: index, orderNumber: index, period: Math.floor(index / 25) + 1, timeActual: new Date(Date.parse('2025-10-22T02:10:00Z') + index * 90000).toISOString() }))
  actions.at(-1).actionType = 'game'
  actions.at(-1).subType = 'end'
  const plan = await planDay([{ id: 'a', time: '2025-10-22T02:00:00Z' }], { json: async () => ({ game: { actions } }) }, '2025-10-21')
  const checkpoint = plan.events.find(event => event.type === 'live')
  assert.ok(checkpoint.at < Date.parse('2025-10-22T04:00:00Z'))
})

test('a retroactively dated PBP action cannot move final delivery beyond the recorded game end', async () => {
  const { planDay } = await import('./planner.mjs')
  const start = Date.parse('2025-11-16T01:00:00Z')
  /** @type {PlannedAction[]} */
  const actions = Array.from({ length: 100 }, (_, index) => ({ actionNumber: index, orderNumber: index, period: Math.floor(index / 25) + 1, timeActual: new Date(start + index * 90000).toISOString() }))
  actions.at(-1).actionType = 'game'
  actions.at(-1).subType = 'end'
  actions[75].timeActual = '2025-11-17T03:01:26.1Z'
  const plan = await planDay([{ id: 'a', time: new Date(start).toISOString() }], { json: async () => ({ game: { actions } }) }, '2025-11-15')
  assert.equal(plan.events.at(-1).at, Date.parse(actions.at(-1).timeActual) + 60000)
  assert.ok(plan.events.every(event => event.at < Date.parse('2025-11-16T09:00:00Z')))
})
