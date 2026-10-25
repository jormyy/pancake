import { strict as assert } from 'node:assert'
import { createNotifyMembers, NotificationDeliveryError, type WebNotificationBatchDependencies } from './notificationDelivery.ts'

const preferences = { trade_enabled: true, waiver_enabled: false, draft_enabled: true, activity_enabled: true }
const dependencies = (overrides: Partial<WebNotificationBatchDependencies> = {}): WebNotificationBatchDependencies => ({
  members: async () => ({ data: [{ id: 'member-a', user_id: 'user-a' }], error: null }),
  preferences: async () => ({ data: [{ user_id: 'user-a', ...preferences }], error: null }),
  webPush: async (messages) => ({ sent: messages.length, pruned: 0, failed: 0,
    results: messages.map(({ userId }) => ({ userId, status: 'sent' })) }),
  ...overrides,
})

Deno.test('web push alone supplies durable sent outcomes without a profile or Expo token', async () => {
  const deps = dependencies()
  const results = await createNotifyMembers(deps)([{ memberId: 'member-a', title: 'Offer', body: 'New offer', category: 'trade' }])
  assert.equal(results[0].status, 'sent')
})

Deno.test('disabled preferences suppress delivery while absent preferences keep the default', async () => {
  let sends = 0
  const deps = dependencies()
  const notify = createNotifyMembers({ ...deps, webPush: async messages => { sends++; return deps.webPush(messages) } })
  assert.deepEqual(await notify([{ memberId: 'member-a', title: 'Waiver', body: 'Claim', category: 'waiver' }]),
    [{ memberId: 'member-a', status: 'skipped', reason: 'preferences_disabled' }])
  assert.equal(sends, 0)
  assert.equal((await createNotifyMembers(dependencies({ preferences: async () => ({ data: [], error: null }) }))([
    { memberId: 'member-a', title: 'Waiver', body: 'Claim', category: 'waiver' },
  ]))[0].status, 'sent')
})

Deno.test('notification lookups fail closed before delivery', async () => {
  for (const override of [
    { members: async () => ({ data: null, error: { message: 'members unavailable' } }) },
    { members: async () => ({ data: [], error: null }) },
    { preferences: async () => ({ data: null, error: { message: 'preferences unavailable' } }) },
  ]) {
    let sent = false
    await assert.rejects(() => createNotifyMembers(dependencies({ ...override,
      webPush: async () => { sent = true; throw new Error('unexpected send') },
    }))([{ memberId: 'member-a', title: 'T', body: 'B' }]), NotificationDeliveryError)
    assert.equal(sent, false)
  }
})

Deno.test('per-user web failures and terminal skips survive notification mapping', async () => {
  for (const outcome of [
    { userId: 'user-a', status: 'failed' as const, retryable: true, error: 'HTTP 503' },
    { userId: 'user-a', status: 'failed' as const, retryable: false, error: 'HTTP 400' },
    { userId: 'user-a', status: 'gone' as const },
    { userId: 'user-a', status: 'no_subscription' as const },
  ]) {
    const [result] = await createNotifyMembers(dependencies({ webPush: async () => ({ sent: 0, pruned: 0, failed: 0, results: [outcome] }) }))([
      { memberId: 'member-a', title: 'T', body: 'B' },
    ])
    assert.equal(result.status, outcome.status === 'failed' ? 'failed' : 'skipped')
    if (result.status === 'failed' && outcome.status === 'failed') assert.equal(result.retryable, outcome.retryable)
  }
})

Deno.test('missing web outcomes are retryable rather than acknowledged', async () => {
  const [result] = await createNotifyMembers(dependencies({ webPush: async () => ({ sent: 0, pruned: 0, failed: 0, results: [] }) }))([
    { memberId: 'member-a', title: 'T', body: 'B' },
  ])
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.equal(result.retryable, true)
})

Deno.test('empty batches do not query notification data', async () => {
  assert.deepEqual(await createNotifyMembers(dependencies({ members: async () => { throw new Error('unexpected lookup') } }))([]), [])
})
