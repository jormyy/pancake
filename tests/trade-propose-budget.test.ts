import { expect, it } from 'vitest'
import { runTradeProposeBudget } from './db/trade-propose-budget.mjs'
import { runTradeWriteContention } from './db/trade-write-contention.mjs'

const senderId = process.env.TRADE_BUDGET_SENDER_ID
const recipientId = process.env.TRADE_BUDGET_RECIPIENT_ID

it.skipIf(!senderId || !recipientId)('bounds proposal SQL on the restored production roster shape', () => {
  expect(() => runTradeProposeBudget(senderId, recipientId, true)).toThrow(/exceeds the 5000 ms budget/)
  expect(runTradeProposeBudget(senderId, recipientId)).toHaveLength(3)
}, 30000)

it.skipIf(!process.env.TRADE_CONTENTION_DB).each([false, true])('keeps trade writes below one second behind scheduler locks with immediate completion %s', async immediate => {
  const result = await runTradeWriteContention(immediate)
  expect(result.proposeMs).toBeLessThan(1000)
  expect(result.acceptMs).toBeLessThan(1000)
  expect(result.busyMs).toBeLessThan(1000)
}, 30000)
