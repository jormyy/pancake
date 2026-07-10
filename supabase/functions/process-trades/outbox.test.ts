import {
  deliverTradeNotificationOutbox,
  OUTBOX_CLAIM_LIMIT,
  OUTBOX_LEASE_SECONDS,
  type TradeNotificationOutboxRow,
} from './outbox.ts'
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

Deno.test('trade notification claims fit in one bounded delivery wave', async () => {
  if (OUTBOX_CLAIM_LIMIT !== 10 || OUTBOX_LEASE_SECONDS !== 60) {
    throw new Error('notification claim policy changed without updating its delivery bound')
  }

  let active = 0
  let maximumActive = 0
  await deliverTradeNotificationOutbox(
    Array.from({ length: OUTBOX_CLAIM_LIMIT }, (_, index) => row(String(index))),
    async (messages) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return messages.map((message) => ({
        memberId: message.memberId,
        status: 'sent' as const,
        ticketId: `ticket-${message.memberId}`,
        pushToken: `token-${message.memberId}`,
      }))
    },
    async () => {},
    async () => {},
    async () => {},
    async () => {},
  )

  if (maximumActive !== OUTBOX_CLAIM_LIMIT) {
    throw new Error(`claimed rows did not start in one wave: ${maximumActive}`)
  }
})

Deno.test('trade notification outbox persists tickets without acknowledging delivery', async () => {
  const ticketed: string[] = []
  const completed: string[] = []
  const result = await deliverTradeNotificationOutbox(
    [row('a'), row('b')],
    async (messages) => messages.map((message) => ({
      memberId: message.memberId,
      status: 'sent' as const,
      ticketId: `ticket-${message.memberId}`,
      pushToken: `token-${message.memberId}`,
    })),
    async (entry, ticketId, pushToken) => { ticketed.push(`${entry.id}:${ticketId}:${pushToken}`) },
    async (entry) => { completed.push(entry.id) },
    async () => {},
    async () => {},
  )

  if (JSON.stringify(result) !== JSON.stringify({ ticketed: 2, failed: 0, discarded: 0, deadLettered: 0 }) ||
      ticketed.length !== 2 || completed.length !== 0) {
    throw new Error(`outbox ticket persistence was incorrect: ${JSON.stringify({ result, ticketed, completed })}`)
  }
})

Deno.test('trade notification outbox releases every lease for durable retry after delivery failure', async () => {
  const failed: Array<{ id: string; error: string }> = []
  const result = await deliverTradeNotificationOutbox(
    [row('a'), row('b')],
    async () => { throw new Error('Expo unavailable') },
    async () => {},
    async () => {},
    async (entry, error) => { failed.push({ id: entry.id, error }) },
    async () => {},
  )

  if (JSON.stringify(result) !== JSON.stringify({ ticketed: 0, failed: 2, discarded: 0, deadLettered: 0 }) ||
      failed.some((entry) => entry.error !== 'Expo unavailable') || failed.length !== 2) {
    throw new Error(`outbox retry state was incorrect: ${JSON.stringify({ result, failed })}`)
  }
})

Deno.test('trade notification outbox separates invalid-device discard, payload dead letter, and credential retry', async () => {
  const completed: string[] = []
  const failed: string[] = []
  const deadLettered: string[] = []
  const result = await deliverTradeNotificationOutbox(
    [row('device'), row('payload'), row('credentials')],
    async (messages) => {
      const memberId = messages[0].memberId
      const expoError = memberId.endsWith('device')
        ? 'DeviceNotRegistered'
        : memberId.endsWith('payload') ? 'MessageTooBig' : 'InvalidCredentials'
      throw new AggregateError([new NotificationDeliveryError({
        code: 'expo_status',
        message: expoError,
        memberId,
        retryable: expoError === 'InvalidCredentials',
        expoError,
      })], 'Expo rejected the notification')
    },
    async () => {},
    async (entry) => { completed.push(entry.id) },
    async (entry) => { failed.push(entry.id) },
    async (entry) => { deadLettered.push(entry.id) },
  )

  if (JSON.stringify(result) !== JSON.stringify({ ticketed: 0, failed: 1, discarded: 1, deadLettered: 1 }) ||
      JSON.stringify(completed) !== JSON.stringify(['device']) ||
      JSON.stringify(failed) !== JSON.stringify(['credentials']) ||
      JSON.stringify(deadLettered) !== JSON.stringify(['payload'])) {
    throw new Error(`outbox failure partition was incorrect: ${JSON.stringify({ result, completed, failed, deadLettered })}`)
  }
})
