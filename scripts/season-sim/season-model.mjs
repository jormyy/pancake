import assert from 'node:assert/strict'

const ranges = { 2025: ['2024-10-22', '2025-04-13'], 2026: ['2025-10-21', '2026-04-12'], 2027: ['2026-10-20', '2027-04-11'] }

export function seasonProfile(year = 2026) {
  year = Number(year)
  assert.ok(Object.hasOwn(ranges, year), 'A pinned season range is required')
  const [start, end] = ranges[year]
  return { year, startYear: year - 1, label: `${year - 1}-${String(year).slice(-2)}`, prefix: `002${String(year - 1).slice(-2)}`, start, end, games: 1230 }
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
