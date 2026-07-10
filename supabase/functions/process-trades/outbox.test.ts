import { deliverTradeNotificationOutbox, type TradeNotificationOutboxRow } from './outbox.ts'

const row = (id: string): TradeNotificationOutboxRow => ({
  id,
  claim_token: `claim-${id}`,
  member_id: `member-${id}`,
  title: 'Accepted Trade Expired',
  body: 'An accepted trade could not be completed.',
  data: { tradeId: `trade-${id}` },
  category: 'trade',
})

Deno.test('trade notification outbox acknowledges every row only after delivery', async () => {
  const completed: string[] = []
  const failed: string[] = []
  const rows = [row('a'), row('b')]
  const result = await deliverTradeNotificationOutbox(
    rows,
    async (messages) => messages.map((message) => ({ memberId: message.memberId, status: 'sent' as const })),
    async (entry) => { completed.push(entry.id) },
    async (entry) => { failed.push(entry.id) },
  )

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 2, failed: 0 }) ||
      JSON.stringify(completed.sort()) !== JSON.stringify(['a', 'b']) || failed.length !== 0) {
    throw new Error(`outbox acknowledgements were incorrect: ${JSON.stringify({ result, completed, failed })}`)
  }
})

Deno.test('trade notification outbox releases every lease for durable retry after delivery failure', async () => {
  const completed: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  const rows = [row('a'), row('b')]
  const result = await deliverTradeNotificationOutbox(
    rows,
    async () => { throw new Error('Expo unavailable') },
    async (entry) => { completed.push(entry.id) },
    async (entry, error) => { failed.push({ id: entry.id, error }) },
  )

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 0, failed: 2 }) || completed.length !== 0 ||
      failed.some((entry) => entry.error !== 'Expo unavailable') || failed.length !== 2) {
    throw new Error(`outbox retry state was incorrect: ${JSON.stringify({ result, completed, failed })}`)
  }
})
