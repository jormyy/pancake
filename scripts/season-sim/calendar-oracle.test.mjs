import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarOracle, checkCalendar, oracleWeek } from './calendar-oracle.mjs'

const games = ['2024-10-22', '2024-10-23', '2025-02-10', '2025-02-13', '2025-02-19', '2025-02-23', '2025-02-24', '2025-04-13'].map((date, i) => ({ id: `00224${String(i).padStart(5, '0')}`, date }))
const dense = []
for (let at = Date.parse('2024-10-22'); at <= Date.parse('2025-04-13'); at += 86400000) {
  const date = new Date(at).toISOString().slice(0, 10)
  if (date >= '2025-02-14' && date <= '2025-02-18') continue
  dense.push({ id: '0022400001', date })
}

test('opening and merged All-Star weeks come from raw regular game dates', () => {
  const c = calendarOracle([...dense, { id: '0062400001', date: '2024-10-01' }, { id: '0012400001', date: '2024-09-30' }])
  assert.equal(c.opening, games[0].date)
  assert.deepEqual(c.weeks[0], { week_number: 1, week_start: '2024-10-22', week_end: '2024-10-27' })
  assert.equal(oracleWeek(c, '2025-02-10'), oracleWeek(c, '2025-02-23'))
  assert.equal(oracleWeek(c, '2025-02-24'), oracleWeek(c, '2025-02-10') + 1)
  assert.equal(c.excluded.length, 2)
})

test('calendar oracle rejects unmerged product weeks and absent opening matchups', () => {
  const c = calendarOracle(dense)
  const matchups = [{ week_number: 1, matchup_type: 'regular_season', home_member_id: 'a', away_member_id: 'b' }]
  assert.ok(checkCalendar(c, c.weeks, matchups, ['a', 'b']).passed)
  assert.throws(() => checkCalendar(c, c.weeks.slice(1), matchups, ['a', 'b']))
  assert.throws(() => checkCalendar(c, c.weeks, [], ['a', 'b']))
  assert.throws(() => calendarOracle(games), /one independently identifiable/)
})

test('a Cup gap cannot invent Monday games or a fantasy range before the first 002 game',()=>{
  const sparse=dense.filter(row=>row.date<'2024-12-16'||row.date>'2024-12-18')
  const c=calendarOracle(sparse)
  assert.equal(c.weeks.find(row=>row.week_end==='2024-12-22').week_start,'2024-12-19')
})
