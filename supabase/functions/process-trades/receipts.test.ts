import {
  deferTradeNotificationReceipts,
  settleTradeNotificationReceipts,
  type TradeNotificationReceiptRow,
} from './receipts.ts'

const row = (id: string): TradeNotificationReceiptRow => ({
  id,
  claim_token: `claim-${id}`,
  member_id: `member-${id}`,
  expo_ticket_id: `ticket-${id}`,
  push_token: `token-${id}`,
})

Deno.test('receipt settlement completes success and clears only an invalid device token', async () => {
  const completed: string[] = []
  const invalidated: string[] = []
  const rows = [row('ok'), row('device')]
  const result = await settleTradeNotificationReceipts(rows, {
    'ticket-ok': { status: 'ok' },
    'ticket-device': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
  }, {
    complete: async (entry) => { completed.push(entry.id) },
    invalidate: async (entry) => { invalidated.push(`${entry.member_id}:${entry.push_token}`) },
    retry: async () => {},
    defer: async () => {},
    deadLetter: async () => {},
  })

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 1, retried: 0, deferred: 0, discarded: 1, deadLettered: 0 }) ||
      JSON.stringify(completed.sort()) !== JSON.stringify(['device', 'ok']) ||
      JSON.stringify(invalidated) !== JSON.stringify(['member-device:token-device'])) {
    throw new Error(`receipt success/device settlement failed: ${JSON.stringify({ result, completed, invalidated })}`)
  }
})

Deno.test('receipt settlement retries credentials and rate failures but dead-letters payload and sender failures', async () => {
  const retried: string[] = []
  const deadLettered: string[] = []
  const rows = [row('credentials'), row('rate'), row('payload'), row('sender')]
  const result = await settleTradeNotificationReceipts(rows, Object.fromEntries(rows.map((entry) => [
    entry.expo_ticket_id,
    {
      status: 'error',
      message: entry.id,
      details: {
        error: entry.id === 'credentials' ? 'InvalidCredentials'
          : entry.id === 'rate' ? 'MessageRateExceeded'
          : entry.id === 'payload' ? 'MessageTooBig' : 'MismatchSenderId',
      },
    },
  ])), {
    complete: async () => {},
    invalidate: async () => {},
    retry: async (entry) => { retried.push(entry.id) },
    defer: async () => {},
    deadLetter: async (entry) => { deadLettered.push(entry.id) },
  })

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 0, retried: 2, deferred: 0, discarded: 0, deadLettered: 2 }) ||
      JSON.stringify(retried.sort()) !== JSON.stringify(['credentials', 'rate']) ||
      JSON.stringify(deadLettered.sort()) !== JSON.stringify(['payload', 'sender'])) {
    throw new Error(`receipt retry/dead-letter settlement failed: ${JSON.stringify({ result, retried, deadLettered })}`)
  }
})

Deno.test('receipt settlement retains a ticket while its receipt or token cleanup is unavailable', async () => {
  const deferred: string[] = []
  const rows = [row('missing'), row('cleanup')]
  const result = await settleTradeNotificationReceipts(rows, {
    'ticket-cleanup': { status: 'error', details: { error: 'DeviceNotRegistered' } },
  }, {
    complete: async () => {},
    invalidate: async (entry) => {
      if (entry.id === 'cleanup') throw new Error('database unavailable')
    },
    retry: async () => {},
    defer: async (entry) => { deferred.push(entry.id) },
    deadLetter: async () => {},
  })

  if (JSON.stringify(result) !== JSON.stringify({ delivered: 0, retried: 0, deferred: 2, discarded: 0, deadLettered: 0 }) ||
      JSON.stringify(deferred.sort()) !== JSON.stringify(['cleanup', 'missing'])) {
    throw new Error(`receipt deferral failed: ${JSON.stringify({ result, deferred })}`)
  }
})

Deno.test('global receipt failure releases 200 leases with bounded mutation concurrency', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => row(`global-${index}`))
  let active = 0
  let maximum = 0
  const released: string[] = []

  await deferTradeNotificationReceipts(rows, async (entry) => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    released.push(entry.id)
    active -= 1
  })

  if (maximum > 10 || released.length !== rows.length || new Set(released).size !== rows.length) {
    throw new Error(`global receipt deferral was not bounded/complete: ${JSON.stringify({ maximum, released: released.length })}`)
  }
})

Deno.test('every transactional trade action routes receipt errors to durable retry', async () => {
  const actions = [
    'offered', 'countered', 'edited', 'participant-accepted', 'accepted',
    'rejected', 'withdrawn', 'vetoed', 'completed', 'expired',
  ]
  const rows = actions.map(row)
  const retried: string[] = []
  const receipts = Object.fromEntries(rows.map((entry) => [entry.expo_ticket_id, {
    status: 'error',
    message: 'rate limited',
    details: { error: 'MessageRateExceeded' },
  }]))

  const result = await settleTradeNotificationReceipts(rows, receipts, {
    complete: async () => {},
    invalidate: async () => {},
    retry: async (entry) => { retried.push(entry.id) },
    defer: async () => {},
    deadLetter: async () => {},
  })

  if (result.retried !== actions.length ||
      JSON.stringify(retried.sort()) !== JSON.stringify([...actions].sort())) {
    throw new Error(`not every trade action was retried: ${JSON.stringify({ result, retried })}`)
  }
})
