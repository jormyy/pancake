import {
  deliverTradeNotificationOutbox,
  drainTradeNotificationOutbox,
  OUTBOX_CLAIM_LIMIT,
  OUTBOX_DRAIN_BUDGET_MS,
  OUTBOX_LEASE_SECONDS,
  OUTBOX_MAX_CLAIMS_PER_RUN,
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

function queue(total: number) {
  const pending = Array.from({ length: total }, (_, index) => row(String(index)))
  let claims = 0
  return {
    claim: async () => {
      claims += 1
      return pending.splice(0, OUTBOX_CLAIM_LIMIT)
    },
    claims: () => claims,
    remaining: () => pending.length,
  }
}

const settled = async (rows: TradeNotificationOutboxRow[]) => ({ ticketed: 0, failed: 0, discarded: rows.length, deadLettered: 0 })

Deno.test('trade notification drain keeps claiming full batches until the queue runs short', async () => {
  const outbox = queue(45)
  const result = await drainTradeNotificationOutbox(outbox.claim, settled)
  if (outbox.claims() !== 5 || outbox.remaining() !== 0 || result.discarded !== 45) {
    throw new Error(`burst was not drained in one run: ${JSON.stringify({ claims: outbox.claims(), result })}`)
  }
})

Deno.test('trade notification drain claims once when the first batch is short or empty', async () => {
  for (const total of [0, 9]) {
    const outbox = queue(total)
    await drainTradeNotificationOutbox(outbox.claim, settled)
    if (outbox.claims() !== 1) throw new Error(`short queue of ${total} claimed ${outbox.claims()} times`)
  }
  const exact = queue(OUTBOX_CLAIM_LIMIT)
  await drainTradeNotificationOutbox(exact.claim, settled)
  if (exact.claims() !== 2) throw new Error(`a full final batch must confirm the queue is empty: ${exact.claims()}`)
})

Deno.test('trade notification drain stops after a retryable failure so backoff decides the retry', async () => {
  const outbox = queue(45)
  let batch = 0
  const result = await drainTradeNotificationOutbox(outbox.claim, async (rows) => {
    batch += 1
    return batch === 2
      ? { ticketed: 0, failed: 1, discarded: rows.length - 1, deadLettered: 0 }
      : settled(rows)
  })
  if (outbox.claims() !== 2 || outbox.remaining() !== 25 || result.failed !== 1 || result.discarded !== 19) {
    throw new Error(`failure did not end the run: ${JSON.stringify({ claims: outbox.claims(), result })}`)
  }
})

Deno.test('trade notification drain is bounded by claims and elapsed time per run', async () => {
  const backlog = queue(OUTBOX_CLAIM_LIMIT * (OUTBOX_MAX_CLAIMS_PER_RUN + 3))
  await drainTradeNotificationOutbox(backlog.claim, settled)
  if (backlog.claims() !== OUTBOX_MAX_CLAIMS_PER_RUN || backlog.remaining() !== OUTBOX_CLAIM_LIMIT * 3) {
    throw new Error(`claim cap was not enforced: ${backlog.claims()}`)
  }

  const slow = queue(45)
  let clock = 0
  await drainTradeNotificationOutbox(slow.claim, async (rows) => {
    clock += OUTBOX_DRAIN_BUDGET_MS / 2
    return settled(rows)
  }, () => clock)
  if (slow.claims() !== 2) throw new Error(`time budget was not enforced: ${slow.claims()}`)
})

Deno.test('trade notification drain propagates claim and delivery errors', async () => {
  for (const [claim, deliver] of [
    [async () => { throw new Error('claim failed') }, settled],
    [queue(45).claim, async () => { throw new Error('lease lost') }],
  ] as const) {
    let message = ''
    try {
      await drainTradeNotificationOutbox(claim, deliver)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    if (!['claim failed', 'lease lost'].includes(message)) throw new Error(`error was swallowed: ${message}`)
  }
})
