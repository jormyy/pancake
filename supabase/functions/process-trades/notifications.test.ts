import { notifyCompletedTrades, notifyExpiredTrades } from './notifications.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error(message)
}
const assertCount = (actual: number, expected: number, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, found ${actual}`)
}

Deno.test('completed trade notifications use bounded concurrency and await every recipient', async () => {
  const gate = deferred()
  let completed = false
  let captured = 0
  const pending = notifyCompletedTrades([{
    trade_id: 'trade-a',
    participant_member_ids: ['member-1', 'member-2', 'member-3', 'member-4'],
  }], async (messages) => {
    captured = messages.length
    await gate.promise
    return messages.map((message) => ({ memberId: message.memberId, status: 'sent' as const }))
  }).then(() => { completed = true })

  await waitFor(() => captured === 4, 'notification batch did not start')
  if (completed) throw new Error('trade notification adapter returned before delivery completed')
  gate.resolve()
  await pending
  assertCount(captured, 4, 'batched notification recipients')
})

Deno.test('trade notification adapter sends the maximum processor cardinality as one bulk operation', async () => {
  const rows = Array.from({ length: 50 }, (_, tradeIndex) => ({
    trade_id: `trade-${tradeIndex}`,
    participant_member_ids: Array.from({ length: 12 }, (_, memberIndex) => `member-${tradeIndex}-${memberIndex}`),
  }))
  let messages: Parameters<Parameters<typeof notifyExpiredTrades>[1]>[0] = []
  await notifyExpiredTrades(rows, async (captured) => {
    messages = captured
    return captured.map((message) => ({ memberId: message.memberId, status: 'sent' as const }))
  })

  assertCount(messages.length, 600, 'maximum-cardinality notification batch')
  if (messages.some((message) => message.title !== 'Trade Expired' || message.category !== 'trade')) {
    throw new Error('expiration notification metadata was lost during batching')
  }
})

Deno.test('expired trade notification failures propagate to the processor boundary', async () => {
  let observed: unknown = null
  try {
    await notifyExpiredTrades([{
      trade_id: 'trade-a',
      participant_member_ids: ['member-1', 'member-2', 'member-3'],
    }], async () => { throw new Error('push batch failed') })
  } catch (error) {
    observed = error
  }

  if (!(observed instanceof Error) || observed.message !== 'push batch failed') {
    throw new Error('notification failure was not surfaced to the processor')
  }
})
