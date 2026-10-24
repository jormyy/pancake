import type { VapidKeys, WebPushResult, WebPushSubscription } from './webPush.ts'
import { createWebPushFanout, type WebPushFanoutMessage, webPushPayload } from './webPushDelivery.ts'

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const KEYS: VapidKeys = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@pancake.test' }
const sub = (userId: string, endpoint: string) => ({ user_id: userId, endpoint, p256dh: 'p', auth: 'a', updated_at: '2026-01-01T00:00:00Z' })
const message = (userId: string, overrides: Partial<WebPushFanoutMessage> = {}): WebPushFanoutMessage => ({
  userId,
  title: 'Trade accepted',
  body: 'Done',
  category: 'trade',
  ...overrides,
})

Deno.test('web push fanout delivers to every subscription and prunes gone endpoints', async () => {
  const sent: Array<{ endpoint: string; payload: unknown; urgency?: string }> = []
  let pruned: string[] = []
  const fanout = createWebPushFanout({
    vapid: () => KEYS,
    subscriptions: async () => ({
      data: [sub('user-a', 'https://a1'), sub('user-a', 'https://a2'), sub('user-b', 'https://b1')],
      error: null,
    }),
    prune: async (endpoints) => {
      pruned = endpoints.map((entry) => entry.endpoint)
      return { error: null }
    },
    send: async (subscription: WebPushSubscription, payload, _keys, options): Promise<WebPushResult> => {
      sent.push({ endpoint: subscription.endpoint, payload, urgency: options?.urgency })
      return subscription.endpoint === 'https://a2' ? { outcome: 'gone', status: 410 } : { outcome: 'sent' }
    },
  })

  const summary = await fanout([message('user-a'), message('user-b', { category: 'draft' }), message('user-c')])
  assert(summary.sent === 2 && summary.pruned === 1 && summary.failed === 0, `unexpected summary ${JSON.stringify(summary)}`)
  assert(sent.length === 3, `expected 3 sends, got ${sent.length}`)
  assert(pruned.length === 1 && pruned[0] === 'https://a2', 'gone endpoint was not pruned')
  assert(sent.find((entry) => entry.endpoint === 'https://b1')?.urgency === 'high', 'draft pushes should be high urgency')
  assert((sent[0].payload as { url: string }).url === '/', 'browser push should open the current account home')
})

Deno.test('web push fanout reports retryable configuration and lookup failures', async () => {
  let looked = false
  const disabled = createWebPushFanout({
    vapid: () => null,
    subscriptions: async () => {
      looked = true
      return { data: [], error: null }
    },
    prune: async () => ({ error: null }),
  })
  const idle = await disabled([message('user-a')])
  assert(idle.sent === 0 && idle.failed === 1 && idle.results[0].status === 'failed' && !looked, 'missing keys must leave the notification retryable')

  const broken = createWebPushFanout({
    vapid: () => KEYS,
    subscriptions: async () => ({ data: null, error: { message: 'db down' } }),
    prune: async () => ({ error: null }),
  })
  assert((await broken([message('user-a')])).failed === 1, 'lookup failure should be reported, not thrown')

  const flaky = createWebPushFanout({
    vapid: () => KEYS,
    subscriptions: async () => ({ data: [sub('user-a', 'https://a1')], error: null }),
    prune: async () => { throw new Error('should not prune') },
    send: async () => { throw new Error('sender exploded') },
  })
  const contained = await flaky([message('user-a')])
  assert(contained.sent === 0 && contained.failed === 1, 'throwing sender should be contained and counted')
})

Deno.test('web push payload contains only generic public text and a home target', () => {
  const payload = webPushPayload()
  assert(JSON.stringify(payload) === JSON.stringify({ title: 'Pancake', body: 'Open Pancake to check for updates.', url: '/' }), 'unexpected private or unrecognized payload fields')
})

Deno.test('web push delivery excludes account details from provider payloads', async () => {
  const payloads: unknown[] = []
  const fanout = createWebPushFanout({
    vapid: () => KEYS,
    subscriptions: async () => ({ data: [sub('user-a', 'https://a1')], error: null }),
    prune: async () => ({ error: null }),
    send: async (_subscription, payload) => { payloads.push(payload); return { outcome: 'sent' } },
  })
  await fanout([message('user-a', { title: 'Secret title', body: 'Secret player', data: { tradeId: 'private-trade' } })])
  const encoded = JSON.stringify(payloads)
  assert(!encoded.includes('Secret') && !encoded.includes('private-trade') && !encoded.includes('user-a'), 'provider receives account details')
  assert(payloads.length === 1 && (payloads[0] as { url: string }).url === '/', 'generic notification must open the current account home')
})

Deno.test('partial device delivery keeps a user retryable without delaying other users', async () => {
  const fanout = createWebPushFanout({
    vapid: () => KEYS,
    subscriptions: async () => ({ data: [sub('user-a', 'sent'), sub('user-a', 'retry'), sub('user-b', 'gone')], error: null }),
    prune: async () => ({ error: null }),
    send: async subscription => subscription.endpoint === 'sent' ? { outcome: 'sent' }
      : subscription.endpoint === 'gone' ? { outcome: 'gone', status: 410 }
      : { outcome: 'failed', retryable: true, status: 503, message: 'Temporary outage' },
  })
  const summary = await fanout([message('user-a'), message('user-b'), message('user-c')])
  assert(summary.results[0].status === 'failed' && summary.results[0].retryable, 'partial success hides a retryable device failure')
  assert(summary.results[1].status === 'gone', 'gone recipient must complete')
  assert(summary.results[2].status === 'no_subscription', 'absent recipient must complete')
})
