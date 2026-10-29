import { expect, test } from 'vitest'
import { buildScheduleSyncPlan, completeSeasonSchedule, fantasyCalendar } from '../../core/src/season/schedule'

const games = (count: number) => Array.from({ length: count }, (_, index) => ({
  gameId: `002260${String(index).padStart(4, '0')}`,
  gameDate: ['2026-10-20', '2026-12-03', '2026-12-12', '2027-02-18', '2027-02-25', '2027-04-12'][index % 6],
  homeTeam: String(index % 30),
  awayTeam: String((index + 1) % 30),
  status: 'Scheduled',
  startedAt: null,
  weekNumber: index % 6 + 1,
}))

test('an eighty-game calendar preserves published weeks without claiming completeness', () => {
  const source = games(1200)
  expect(completeSeasonSchedule(source)).toBe(false)
  const plan = buildScheduleSyncPlan(source, new Date('2026-10-28T12:00:00Z'), true)
  expect(plan.rows.every(row => !row.schedule_complete)).toBe(true)
  expect(plan.rows.map(row => row.week_number)).toEqual(source.map(game => game.weekNumber))
})

test('a complete eighty-two-game calendar still rejects multiple long breaks', () => {
  expect(completeSeasonSchedule(games(1230))).toBe(true)
  expect(() => fantasyCalendar(games(1230).map(game => game.gameDate))).toThrow('multiple long breaks')
})
