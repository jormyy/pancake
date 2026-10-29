import { expect, it } from 'vitest'
import { assertTwoDayWaiverWindow, transferFaab, twoDayAuctionDate } from '../../scripts/perf-lab/waiver-plan.mjs'
import { nextWaiverRun, overBudgetWaiverBid } from '../../scripts/season-sim/waiver-scenarios.mjs'

it('keeps the waiver oracle and rejection bid consistent with the completed countertrade', () => {
  const before = { recipient: 100, sender: 100, other: 100 }
  const after = transferFaab(before, 'sender', 'recipient', 1)
  expect(before).toEqual({ recipient: 100, sender: 100, other: 100 })
  expect(after).toEqual({ recipient: 101, sender: 99, other: 100 })
  expect(overBudgetWaiverBid(before.recipient)).toBe(101)
  expect(overBudgetWaiverBid(after.recipient)).toBe(102)
  expect(overBudgetWaiverBid(after.sender)).toBe(100)
  expect((Object.values(after) as number[]).reduce((sum, value) => sum + value, 0)).toBe(300)
})

it('rejects an impossible transfer and an unknown waiver balance', () => {
  expect(() => transferFaab({ a: 0, b: 100 }, 'a', 'b', 1)).toThrow()
  expect(() => overBudgetWaiverBid(Number.NaN)).toThrow()
})

it('keeps the genuine 48-hour hold and 03:00 Eastern run inside the two-day closing window', () => {
  const processAt = (day: string) => nextWaiverRun(Date.parse(`${day}T14:10:00Z`) + 48 * 3600000)
  expect(() => assertTwoDayWaiverWindow('2025-10-22', [{ processAt: processAt('2025-10-22') }])).toThrow('48-hour')
  const prelude = twoDayAuctionDate('2025-10-22')
  expect(prelude).toBe('2025-10-21')
  expect(() => assertTwoDayWaiverWindow('2025-10-22', [{ processAt: processAt(prelude) }])).not.toThrow()
  expect(new Date(processAt(prelude)).toISOString()).toBe('2025-10-24T07:00:00.000Z')
})
