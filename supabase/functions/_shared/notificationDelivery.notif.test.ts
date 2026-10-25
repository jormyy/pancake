import { createNotifyMembers } from './notificationDelivery.ts'
import { notificationEvents, normalizeNotificationPreferences } from './notificationsPreferences.ts'
import { strict as assert } from 'node:assert'
import { deliverNotificationOutbox } from '../process-trades/outbox.ts'

Deno.test('notification without a delivery route stays retryable', async () => {
  let completed = 0
  let failed = 0
  const result = await deliverNotificationOutbox([
    { id: 'outbox', claim_token: 'lease', member_id: 'member', title: 'Title', body: 'Body', data: {}, category: 'trade' },
  ], async () => [{ memberId: 'member', status: 'skipped', reason: 'missing_push_token' }],
  async () => { completed++ }, async () => { failed++ },
  async () => { throw new Error('No dead letter expected') })
  assert.equal(completed, 0, 'Missing transport cannot be called delivered')
  assert.equal(failed, 1)
  assert.equal(result.failed, 1)
})


Deno.test('web delivery does not repeat when Expo retries', async () => {
  let webSends = 0
  let expoSends = 0
  let webState = 'send'
  const dependencies = {
    members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
    preferences: async () => ({ data: [], error: null }),
    profiles: async () => ({ data: [{ id: 'user', push_token: 'fake-token' }], error: null }),
    pushUrl: 'http://127.0.0.1:57880/send',
    send: async () => {
      expoSends++
      return expoSends === 1 ? new Response('fake outage', { status: 503 }) : Response.json({ data: [{ status: 'ok', id: 'ticket' }] })
    },
    beginWebDelivery: async (): Promise<'send' | 'delivered'> => webState === 'send' ? 'send' : 'delivered',
    finishWebDelivery: async () => { webState = 'delivered' },
    webPush: async () => { webSends++; return { sent: 1, failed: 0, pruned: 0, results: [] } },
  }
  const notify = createNotifyMembers(dependencies)
  const messages = [{ memberId: 'member', title: 'Title', body: 'Body', category: 'trade' as const,
    data: { notificationEvent: 'trade_offered' }, delivery: { id: 'outbox', claimToken: 'lease' } }]
  await assert.rejects(() => notify(messages))
  await notify(messages)
  assert.equal(expoSends, 2)
  assert.equal(webSends, 1, 'Expo retry cannot resend an already delivered web notification')
})

Deno.test('web-only delivery provides delivery evidence', async () => {
  const notify = createNotifyMembers({
    members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
    preferences: async () => ({ data: [], error: null }),
    profiles: async () => ({ data: [], error: null }),
    pushUrl: 'http://127.0.0.1:57880/send',
    send: async () => { throw new Error('Expo must not run without a token') },
    webPush: async () => ({ sent: 1, failed: 0, pruned: 0, results: [] }),
  })
  const [result] = await notify([{ memberId: 'member', title: 'Title', body: 'Body', category: 'trade', data: { notificationEvent: 'trade_offered' }, delivery: { id: 'outbox', claimToken: 'lease' } }])
  assert.equal(result.status, 'sent')
  assert.ok(result.status === 'sent' && result.channel === 'web')
})

for (const event of notificationEvents) {
  Deno.test(`${event.key} resolves preferences before fake transport`, async () => {
    let sends = 0
    const settings = {
      user_id: 'user', trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true,
      master_enabled: true, category_settings: { [event.category]: true }, event_settings: { [event.key]: true },
    }
    const notify = createNotifyMembers({
      members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
      preferences: async () => ({ data: [settings], error: null }),
      profiles: async () => ({ data: [{ id: 'user', push_token: 'fake-token' }], error: null }),
      pushUrl: 'http://127.0.0.1:57880/send',
      send: async () => { sends++; return Response.json({ data: [{ status: 'ok', id: 'ticket' }] }) },
    })
    const message = { memberId: 'member', title: event.label, body: 'Synthetic oracle', category: event.category, data: { notificationEvent: event.key } }
    await notify([message])
    assert.equal(sends, 1)
    settings.event_settings[event.key] = false
    const [suppressed] = await notify([message])
    assert.equal(suppressed.status, 'skipped')
    assert.equal(sends, 1)
    settings.event_settings[event.key] = true
    settings.category_settings[event.category] = false
    await notify([message])
    assert.equal(sends, 1)
    settings.category_settings[event.category] = true
    settings.master_enabled = false
    await notify([message])
    assert.equal(sends, 1)
  })
}

Deno.test('web state failure retains a successful Expo ticket', async () => {
  const notify = createNotifyMembers({
    members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
    preferences: async () => ({ data: [], error: null }),
    profiles: async () => ({ data: [{ id: 'user', push_token: 'fake-token' }], error: null }),
    send: async () => Response.json({ data: [{ status: 'ok', id: 'accepted-ticket' }] }),
    pushUrl: 'http://127.0.0.1:57880/send',
    beginWebDelivery: async () => { throw new Error('Synthetic state outage') },
    webPush: async () => { throw new Error('No web send after a state outage') },
  })
  const [result] = await notify([{ memberId: 'member', title: 'Title', body: 'Body', category: 'trade',
    data: { notificationEvent: 'trade_offered' }, delivery: { id: 'outbox', claimToken: 'lease' } }])
  assert.ok(result.status === 'sent' && result.ticketId === 'accepted-ticket')
})

Deno.test('send admission rechecks draft state after profile lookup and blocks both transports', async () => {
  let live = true
  let lookups = 0
  let sends = 0
  const notify = createNotifyMembers({
    members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
    preferences: async () => ({ data: [{ user_id: 'user', master_enabled: false, trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true }], error: null }),
    profiles: async () => {
      lookups++
      live = false
      return { data: [{ id: 'user', push_token: 'fake-token' }], error: null }
    },
    admitDelivery: async () => {
      assert.equal(lookups, 1)
      return live
    },
    send: async () => { sends++; throw new Error('Stale Expo send') },
    webPush: async () => { sends++; throw new Error('Stale Web Push send') },
    pushUrl: 'http://127.0.0.1:57880/send',
  })
  assert.deepEqual(await notify([{ memberId: 'member', title: 'Turn', body: 'Turn', category: 'draft',
    data: { notificationEvent: 'draft_on_clock' }, delivery: { id: 'outbox', claimToken: 'lease' } }]),
  [{ memberId: 'member', status: 'skipped', reason: 'durably_suppressed' }])
  assert.equal(sends, 0)
})


Deno.test('stored JSON validation keeps malformed settings from enabling default-off push events', async () => {
  const malformed: unknown[] = [null, [true], 'true', 1, true,
    { draft: 1, trade: 'false', draft_timer_expiring: 'true', owned_player_ruled_out: 1 },
    { unknown: true, constructor: true, toString: true }]
  for (const value of malformed) {
    const settings = normalizeNotificationPreferences({
      trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true,
      category_settings: value, event_settings: value,
    })
    assert.deepEqual(settings.category_settings, {})
    assert.deepEqual(settings.event_settings, {})
    const sent: string[] = []
    const notify = createNotifyMembers({
      members: async ids => ({ data: ids.map(id => ({ id, user_id: 'user' })), error: null }),
      preferences: async () => ({ data: [{ user_id: 'user', ...settings }], error: null }),
      profiles: async () => ({ data: [{ id: 'user', push_token: 'fake-token' }], error: null }),
      pushUrl: 'http://127.0.0.1:57880/send',
      send: async (_, init) => {
        const messages = JSON.parse(String(init.body))
        sent.push(...messages.map((message: { data: { notificationEvent: string } }) => message.data.notificationEvent))
        return Response.json({ data: messages.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
      },
    })
    await notify(notificationEvents.map(event => ({ memberId: event.key, category: event.category,
      title: event.label, body: 'Synthetic JSON oracle', data: { notificationEvent: event.key } })))
    assert.deepEqual(sent, notificationEvents.filter(event => event.defaultEnabled).map(event => event.key))
  }
})

Deno.test('web-only success counts as delivered and never discarded', async () => {
  const result = await deliverNotificationOutbox([
    { id: 'web', claim_token: 'lease', member_id: 'member', title: 'Title', body: 'Body', data: {}, category: 'trade' },
  ], async () => [{ memberId: 'member', status: 'sent', channel: 'web' }],
  async () => {}, async (_, error) => { throw new Error(error) },
  async (_, error) => { throw new Error(error) })
  assert.equal(result.discarded, 0)
  assert.equal(result.delivered, 1)
})

Deno.test('Expo ticket persists before an unfinished Web Push call', async () => {
  let recorded = false
  let finishWeb: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { finishWeb = resolve })
  const dependencies = {
    members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
    preferences: async () => ({ data: [], error: null }),
    profiles: async () => ({ data: [{ id: 'user', push_token: 'fake' }], error: null }),
    pushUrl: 'http://127.0.0.1/fake',
    send: async () => Response.json({ data: [{ status: 'ok', id: 'durable-ticket' }] }),
    persistExpoTicket: async () => { recorded = true },
    webPush: async () => { await waiting; return { sent: 1, failed: 0, pruned: 0, results: [] } },
  }
  const pending = createNotifyMembers(dependencies)([{ memberId: 'member', title: 'Title', body: 'Body', category: 'trade', delivery: { id: 'outbox', claimToken: 'lease' } }])
  try {
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(recorded, true, 'Known Expo acceptance must persist before Web Push finishes')
  } finally {
    finishWeb?.()
    await pending
  }
})

Deno.test('outbox counts an already persisted Expo ticket', async () => {
  const result = await deliverNotificationOutbox([{ id: 'expo', claim_token: 'lease', member_id: 'member', title: 'Title', body: 'Body', data: {}, category: 'trade' }],
    async () => [{ memberId: 'member', status: 'sent', ticketId: 'ticket', pushToken: 'token', ticketRecorded: true }],
    async () => {}, async () => {}, async () => {})
  assert.equal(result.ticketed, 1)
})

Deno.test('Web Push reserves its attempt before Expo can clear the lease', async () => {
  let expoStarted = false
  let release: (() => void) | undefined
  const reservation = new Promise<void>(resolve => { release = resolve })
  const pending = createNotifyMembers({
    members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
    preferences: async () => ({ data: [], error: null }),
    profiles: async () => ({ data: [{ id: 'user', push_token: 'fake' }], error: null }),
    beginWebDelivery: async () => { await reservation; return 'send' },
    webPush: async () => ({ sent: 1, failed: 0, pruned: 0, results: [] }),
    send: async () => { expoStarted = true; return Response.json({ data: [{ status: 'ok', id: 'ticket' }] }) },
    pushUrl: 'http://127.0.0.1/fake',
  })([{ memberId: 'member', title: 'Title', body: 'Body', category: 'trade', delivery: { id: 'outbox', claimToken: 'lease' } }])
  try {
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(expoStarted, false, 'Expo must wait for the Web Push reservation')
  } finally {
    release?.()
    await pending
  }
})

for (const [event, category] of [['rookie_draft_pick', 'draft'], ['waiver_claim_succeeded', 'waiver'], ['waiver_claim_failed', 'waiver']] as const) {
  Deno.test(`${event} keeps category and master preferences on the Web Push path`, async () => {
    let sends = 0
    const settings = { user_id: 'user', trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true,
      master_enabled: true, category_settings: { [category]: true } }
    const notify = createNotifyMembers({
      members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
      preferences: async () => ({ data: [settings], error: null }),
      webPush: async messages => {
        sends++
        return { sent: 1, failed: 0, pruned: 0, results: messages.map(({ userId }) => ({ userId, status: 'sent' })) }
      },
    })
    const message = { memberId: 'member', title: 'Result', body: 'Result', category, data: { notificationEvent: event } }
    assert.equal((await notify([message]))[0].status, 'sent')
    settings.category_settings[category] = false
    assert.equal((await notify([message]))[0].status, 'skipped')
    settings.category_settings[category] = true
    settings.master_enabled = false
    assert.equal((await notify([message]))[0].status, 'skipped')
    assert.equal(sends, 1)
  })
}

Deno.test('Web Push retries a known failure and reuses saved success after acknowledgement fails', async () => {
  let sends = 0
  let state: 'send' | 'delivered' = 'send'
  const notify = createNotifyMembers({
    members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
    preferences: async () => ({ data: [], error: null }),
    beginWebDelivery: async () => state,
    finishWebDelivery: async (_, sent) => { state = sent ? 'delivered' : 'send' },
    webPush: async messages => {
      sends++
      return { sent: sends === 1 ? 0 : 1, failed: sends === 1 ? 1 : 0, pruned: 0,
        results: messages.map(({ userId }) => sends === 1
          ? { userId, status: 'failed', retryable: true, error: 'HTTP 503' }
          : { userId, status: 'sent' }) }
    },
  })
  const message = { memberId: 'member', title: 'Result', body: 'Result', delivery: { id: 'outbox', claimToken: 'lease' } }
  assert.equal((await notify([message]))[0].status, 'failed')
  assert.equal((await notify([message]))[0].status, 'sent')
  assert.equal((await notify([message]))[0].status, 'sent')
  assert.equal(sends, 2)
})

for (const outcome of [
  { status: 'failed', retryable: false, error: 'HTTP 400' },
  { status: 'failed', retryable: true, error: 'HTTP 503' },
  { status: 'no_subscription' },
  { status: 'gone' },
] as const) {
  Deno.test(`combined delivery preserves the Web Push ${outcome.status} outcome without an Expo token`, async () => {
    const notify = createNotifyMembers({
      members: async () => ({ data: [{ id: 'member', user_id: 'user' }], error: null }),
      preferences: async () => ({ data: [], error: null }),
      profiles: async () => ({ data: [], error: null }),
      send: async () => { throw new Error('Expo needs a token') },
      pushUrl: 'http://127.0.0.1/fake',
      webPush: async () => ({ sent: 0, failed: 1, pruned: 0, results: [{ userId: 'user', ...outcome }] }),
    })
    const [result] = await notify([{ memberId: 'member', title: 'Result', body: 'Result', delivery: { id: 'outbox', claimToken: 'lease' } }])
    if (outcome.status === 'failed') {
      assert.deepEqual(result, { memberId: 'member', ...outcome })
    } else {
      assert.deepEqual(result, { memberId: 'member', status: 'skipped', reason: outcome.status })
    }
  })
}
