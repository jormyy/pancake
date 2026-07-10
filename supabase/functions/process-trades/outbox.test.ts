import { deliverTradeNotificationOutbox, type TradeNotificationOutboxRow } from './outbox.ts'
import { NotificationDeliveryError } from '../_shared/notificationDelivery.ts'

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

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 2, failed: 0, discarded: 0 }) ||
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

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 0, failed: 2, discarded: 0 }) || completed.length !== 0 ||
      failed.some((entry) => entry.error !== 'Expo unavailable') || failed.length !== 2) {
    throw new Error(`outbox retry state was incorrect: ${JSON.stringify({ result, completed, failed })}`)
  }
})

Deno.test('trade notification outbox settles successful and permanent rows without duplicate retry', async () => {
  const completed: string[] = []
  const failed: string[] = []
  const deliveries: string[] = []
  const rows = [row('ok'), row('invalid')]
  const result = await deliverTradeNotificationOutbox(
    rows,
    async (messages) => {
      deliveries.push(messages[0].memberId)
      if (messages[0].memberId.endsWith('invalid')) {
        throw new AggregateError([new NotificationDeliveryError({
          code: 'expo_status',
          message: 'Device not registered',
          memberId: messages[0].memberId,
          retryable: false,
          expoError: 'DeviceNotRegistered',
        })], 'Expo rejected the token')
      }
      return [{ memberId: messages[0].memberId, status: 'sent' }]
    },
    async (entry) => { completed.push(entry.id) },
    async (entry) => { failed.push(entry.id) },
  )

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 1, failed: 0, discarded: 1 }) ||
      JSON.stringify(completed.sort()) !== JSON.stringify(['invalid', 'ok']) || failed.length !== 0 ||
      JSON.stringify(deliveries.sort()) !== JSON.stringify(['member-invalid', 'member-ok'])) {
    throw new Error(`partial outbox settlement was incorrect: ${JSON.stringify({ result, completed, failed, deliveries })}`)
  }
})
