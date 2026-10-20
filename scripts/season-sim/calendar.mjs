import assert from 'node:assert/strict'

export function publishedWeekNumber(value) {
  if (value.trim() === '') return null
  const week = Number(value)
  assert.ok(Number.isInteger(week) && week > 0, 'Invalid published week number')
  return week
}
