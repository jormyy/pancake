import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSkippedWeek, checkNextSchedule } from './skipped-week.mjs'

test('skipped week rejects phantom matchups, lineups and standings separately', () => {
  const input = { week: 1, matchups: [{ week_number: 2 }], lineups: [], standings: [] }
  assert.ok(checkSkippedWeek(input).passed)
  for (const key of ['matchups', 'lineups', 'standings']) assert.throws(() => checkSkippedWeek({ ...input, [key]: [{ week_number: 1 }] }), /Skipped week 1/)
})

test('next-season schedule preserves calendar weeks and every member before the playoff boundary', () => {
  const members = ['a', 'b', 'c', 'd']
  const rows = [2, 3].flatMap(week_number => [{ week_number, matchup_type: 'regular_season', home_member_id: 'a', away_member_id: 'b' }, { week_number, matchup_type: 'regular_season', home_member_id: 'c', away_member_id: 'd' }])
  assert.deepEqual(checkNextSchedule(rows, members, 4, [1]).regularWeeks, [2, 3])
  assert.throws(() => checkNextSchedule([{ ...rows[0], week_number: 4 }, ...rows.slice(1)], members, 4, [1]), /calendar week 2/)
  assert.throws(() => checkNextSchedule([...rows, { ...rows[0], week_number: 1 }], members, 4, [1]), /playoff boundary/)
  assert.throws(() => checkNextSchedule([{ ...rows[0], home_member_id: 'c' }, ...rows.slice(1)], members, 4, [1]), /every member once/)
})
