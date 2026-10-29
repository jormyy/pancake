import assert from 'node:assert/strict'

export function transferFaab(budgets, from, to, amount) {
  assert.ok(from !== to && Number.isInteger(amount) && amount > 0)
  for (const member of [from, to]) assert.ok(Number.isInteger(budgets[member]) && budgets[member] >= 0)
  assert.ok(budgets[from] >= amount)
  return { ...budgets, [from]: budgets[from] - amount, [to]: budgets[to] + amount }
}

export function twoDayAuctionDate(start) {
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
  return new Date(Date.parse(`${start}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)
}

export function assertTwoDayWaiverWindow(start, scenarios) {
  const end = new Date(Date.parse(`${start}T09:00:00Z`) + 2 * 86400000).getTime()
  assert.ok(scenarios.length && scenarios.every(row => row.processAt <= end), 'The real 48-hour waiver holds must clear inside the two-day closing window')
}
