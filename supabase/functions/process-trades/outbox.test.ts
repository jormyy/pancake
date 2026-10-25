import {
  deliverTradeNotificationOutbox,
  drainTradeNotificationOutbox,
  OUTBOX_CLAIM_LIMIT,
  OUTBOX_DRAIN_BUDGET_MS,
  OUTBOX_LEASE_SECONDS,
  OUTBOX_MAX_CLAIMS_PER_RUN,
  type TradeNotificationOutboxRow,
} from './outbox.ts'
import { strict as assert } from 'node:assert'
import { createNotifyMembers } from '../_shared/notificationDelivery.ts'
import { createWebPushFanout } from '../_shared/webPushDelivery.ts'

const row = (id: string): TradeNotificationOutboxRow => ({
  id,
  claim_token: `claim-${id}`,
  member_id: `member-${id}`,
  title: 'Accepted Trade Expired',
  body: 'An accepted trade could not be completed.',
  data: { tradeId: `trade-${id}` },
  category: 'trade',
})

Deno.test('web push outbox completes sent, absent and gone recipients and retries temporary failures', async () => {
  const completed: string[] = []
  const failed: string[] = []
  const dead: string[] = []
  const notify = createNotifyMembers({
    members: async ids => ({ data: ids.map(id => ({ id, user_id: id })), error: null }),
    preferences: async () => ({ data: [], error: null }),
    webPush: createWebPushFanout({
      vapid: () => ({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:test@example.test' }),
      subscriptions: async ids => ({ data: ids.filter(id => !id.endsWith('absent')).map(id => ({
        user_id: id, endpoint: id, p256dh: 'p', auth: 'a', updated_at: '2026-01-01T00:00:00Z',
      })), error: null }),
      prune: async () => ({ error: null }),
      send: async subscription => {
        if (subscription.endpoint.endsWith('sent')) return { outcome: 'sent' }
        if (subscription.endpoint.endsWith('gone')) return { outcome: 'gone', status: 410 }
        const status = subscription.endpoint.endsWith('throttled') ? 429 : subscription.endpoint.endsWith('unavailable') ? 503 : 400
        return { outcome: 'failed', status, retryable: status !== 400, message: `HTTP ${status}` }
      },
    }),
  })
  const result = await deliverTradeNotificationOutbox(
    ['sent', 'absent', 'gone', 'throttled', 'unavailable', 'invalid'].map(row), notify,
    async entry => { completed.push(entry.id) },
    async entry => { failed.push(entry.id) },
    async entry => { dead.push(entry.id) },
  )
  assert.deepEqual(completed.sort(), ['absent', 'gone', 'sent'])
  assert.deepEqual(failed.sort(), ['throttled', 'unavailable'])
  assert.deepEqual(dead, ['invalid'])
  assert.deepEqual(result, { delivered: 1, failed: 2, discarded: 2, deadLettered: 1 })
})

Deno.test('trade notification claims fit in one bounded delivery wave', async () => {
  assert.equal(OUTBOX_CLAIM_LIMIT, 10)
  assert.equal(OUTBOX_LEASE_SECONDS, 60)
  let active = 0
  let maximum = 0
  await deliverTradeNotificationOutbox(Array.from({ length: OUTBOX_CLAIM_LIMIT }, (_, index) => row(String(index))),
    async messages => {
      maximum = Math.max(maximum, ++active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return messages.map(message => ({ memberId: message.memberId, status: 'sent' }))
    }, async () => {}, async () => {}, async () => {})
  assert.equal(maximum, OUTBOX_CLAIM_LIMIT)
})

Deno.test('missing outcomes and failed acknowledgements schedule a durable retry', async () => {
  for (const mode of ['missing', 'lookup', 'acknowledgement']) {
    const failed: string[] = []
    const result = await deliverTradeNotificationOutbox([row(mode)], async messages => {
      if (mode === 'lookup') throw new Error('lookup failed')
      return mode === 'missing' ? [] : messages.map(message => ({ memberId: message.memberId, status: 'sent' }))
    }, async () => { throw new Error('acknowledgement failed') }, async entry => { failed.push(entry.id) }, async () => {})
    assert.deepEqual(failed, [mode])
    assert.equal(result.failed, 1)
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

const settled = async (rows: TradeNotificationOutboxRow[]) => ({ delivered: 0, failed: 0, discarded: rows.length, deadLettered: 0 })

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
      ? { delivered: 0, failed: 1, discarded: rows.length - 1, deadLettered: 0 }
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

Deno.test('a durable send-time suppression does not acknowledge delivery or schedule a retry', async () => {
  let mutations = 0
  const result = await deliverTradeNotificationOutbox([row('stale')], async messages => messages.map(message => ({
    memberId: message.memberId, status: 'skipped', reason: 'durably_suppressed',
  })), async () => { mutations += 1 }, async () => { mutations += 1 },
  async () => { mutations += 1 }, async () => { mutations += 1 })
  if (mutations !== 0 || result.discarded !== 1) throw new Error('Durable suppression changed delivery state')
})

Deno.test('drain preserves delivered Web Push counts', async () => {
  const result = await drainTradeNotificationOutbox(async () => [row('web')],
    async () => ({ delivered: 1, failed: 0, discarded: 0, deadLettered: 0 }))
  if (result.delivered !== 1 || result.discarded !== 0) throw new Error('Web delivery count was lost')
})
