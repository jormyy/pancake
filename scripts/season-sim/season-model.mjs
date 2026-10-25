import assert from 'node:assert/strict'

// Fallback for tools that carry no schedule; season-model.test.mjs pins it to the real schedules in tests/fixtures/calendar.
const ranges = { 2025: ['2024-10-22', '2025-04-13'], 2026: ['2025-10-21', '2026-04-12'], 2027: ['2026-10-20', '2027-04-11'] }

// With a schedule, a season runs from its first to its last regular-season (002) game day, the day the product opens its
// calendar on: rows carry id or gameId and date or gameDateEst, as calendarOracle reads them.
export function seasonProfile(year = 2026, schedule = null) {
  year = Number(year)
  const prefix = `002${String(year - 1).slice(-2)}`
  let range = ranges[year]
  if (schedule) {
    const days = schedule.filter(row => String(row.id ?? row.gameId).startsWith(prefix)).map(row => row.date ?? row.gameDateEst.slice(0, 10)).sort()
    assert.ok(days.length, `The schedule has no ${year} regular-season game`)
    range = [days[0], days.at(-1)]
  }
  assert.ok(range, 'A pinned season range is required')
  const [start, end] = range
  return { year, startYear: year - 1, label: `${year - 1}-${String(year).slice(-2)}`, prefix, start, end, games: 1230 }
}

export function regularGame(id) {
  return /^002\d{7}$/.test(String(id))
}

export function shiftDay(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}

export function monday(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return shiftDay(date, -((day + 6) % 7))
}
