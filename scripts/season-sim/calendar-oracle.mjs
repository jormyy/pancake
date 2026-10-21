import assert from 'node:assert/strict'
import { monday, regularGame, shiftDay } from './season-model.mjs'

export function calendarOracle(games) {
  const regular = games.filter(game => regularGame(game.id ?? game.gameId))
  assert.ok(regular.length, 'The calendar needs regular-season games')
  const days = [...new Set(regular.map(game => game.date ?? game.gameDateEst.slice(0, 10)))].sort()
  const gaps = days.slice(1).flatMap((date, index) => {
    const missing = (Date.parse(date) - Date.parse(days[index])) / 86400000 - 1
    return missing >= 4 ? [{ before: days[index], after: date, missing }] : []
  })
  assert.equal(gaps.length, 1, 'A complete season has one independently identifiable All-Star gap')
  const gap = gaps[0], before = monday(gap.before), after = monday(gap.after)
  assert.equal(after, shiftDay(before, 7), 'The All-Star gap spans adjacent NBA calendar weeks')
  const starts = [...new Set(days.map(monday))]
  const weeks = []
  for (const start of starts) {
    if (start === after) continue
    const end = shiftDay(start, start === before ? 13 : 6)
    const contained = days.filter(date => date >= start && date <= end)
    weeks.push({ week_number: weeks.length + 1, week_start: contained[0], week_end: contained.at(-1) })
  }
  return { provenance: 'REAL-DERIVED', rule: 'First 002 game date; one observed no-game gap merges adjacent NBA weeks; later weeks shift down one.', opening: days[0], end: days.at(-1), gap, weeks, regularGames: regular.length, excluded: games.filter(game => !regularGame(game.id ?? game.gameId)).map(game => game.id ?? game.gameId) }
}

export function oracleWeek(calendar, date) {
  const row = calendar.weeks.find(week => date >= week.week_start && date <= week.week_end)
  assert.ok(row, `No independent fantasy week for ${date}`)
  return row.week_number
}

export function checkCalendar(calendar, actual, matchups, members, skipped = []) {
  assert.deepEqual(actual.map(({ week_number, week_start, week_end }) => ({ week_number, week_start, week_end })), calendar.weeks, 'Product weeks equal the raw-schedule calendar oracle')
  const eligible = calendar.weeks.find(row => !skipped.includes(row.week_number)).week_number
  const first = matchups.filter(row => row.matchup_type === 'regular_season' && row.week_number === eligible && !row.is_voided)
  assert.equal(first.length, members.length / 2, 'Every first-eligible matchup exists')
  assert.deepEqual(first.flatMap(row => [row.home_member_id, row.away_member_id]).sort(), [...members].sort(), 'First-eligible matchups include every manager once')
  assert.ok(matchups.every(row => !skipped.includes(row.week_number) || row.is_voided), 'Skipped weeks have no active matchup')
  return { passed: true, opening: calendar.opening, firstWeek: calendar.weeks[0], firstEligibleWeek: eligible, allStar: calendar.weeks.find(row => calendar.gap.before >= row.week_start && calendar.gap.after <= row.week_end) }
}
