import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { seasonProfile, regularGame, monday, shiftDay } from './season-model.mjs'
import { criteria } from './criteria.mjs'

test('season profiles derive IDs and years for both real seasons', () => {
  assert.equal(seasonProfile(2025).prefix, '00224')
  assert.equal(seasonProfile(2026).label, '2025-26')
  assert.equal(monday('2024-10-22'), '2024-10-21')
  assert.throws(() => seasonProfile(2000))
  for (const prefix of ['001', '003', '004', '005', '006']) assert.equal(regularGame(`${prefix}2400001`), false)
  assert.ok(regularGame('0022400001'))
  assert.ok(regularGame('0022500001'))
})

// REAL-DERIVED: the real ESPN schedules of tests/fixtures/calendar, Cup final excluded, numbered in order under each season's
// 002 prefix (the fixtures carry ESPN ids only).
const realSchedule = year => JSON.parse(readFileSync(new URL(`../../tests/fixtures/calendar/espn-${year - 1}-${year}.json`, import.meta.url), 'utf8')).games
  .filter(game => !game.cupFinal).map((game, index) => ({ id: `002${String(year - 1).slice(-2)}${String(index + 1).padStart(5, '0')}`, date: game.gameDate }))

test('a schedule gives a season its first and last regular-season game day, whatever the fallback table says', () => {
  const late = realSchedule(2026).filter(row => row.date !== '2025-10-21').reverse()
  assert.deepEqual([seasonProfile(2026, late).start, seasonProfile(2026, late).end], ['2025-10-22', '2026-04-12'])
  const rows = [{ gameId: '0012700001', gameDateEst: '2027-10-02T00:00:00Z' }, { gameId: '0022700001', gameDateEst: '2027-10-26T00:00:00Z' }, { gameId: '0062700001', gameDateEst: '2027-12-18T00:00:00Z' }, { gameId: '0022701230', gameDateEst: '2028-04-16T00:00:00Z' }, { gameId: '0022600001', date: '2026-10-20' }]
  assert.deepEqual(seasonProfile(2028, rows), { year: 2028, startYear: 2027, label: '2027-28', prefix: '00227', start: '2027-10-26', end: '2028-04-16', games: 1230 })
  assert.throws(() => seasonProfile(2028, rows.slice(0, 1)), /no 2028 regular-season game/)
})

test('the fallback ranges and the dated acceptance checkpoints match the real schedules', () => {
  for (const year of [2025, 2026]) assert.deepEqual(seasonProfile(year), seasonProfile(year, realSchedule(year)))
  const [first, second] = [2025, 2026].map(year => seasonProfile(year, realSchedule(year))), byYear = { 2025: first, 2026: second }
  for (const row of criteria.flatMap(item => item.expected.map(expected => ({ ...expected, id: item.id })))) {
    const profile = byYear[row.year] ?? (row.date > first.end ? second : first)
    if (/^(opening morning|opening before played|every live tick)$/.test(row.phase)) assert.equal(row.date, profile.start, row.id)
    if (row.phase === 'after first final') assert.equal(row.date, shiftDay(profile.start, 1), row.id)
    if (/(^|and |then )final$|champion|all weeks|every week closes|box coverage|stat coverage/.test(row.phase) && row.year) assert.equal(row.date, shiftDay(profile.end, 1), row.id)
  }
})
