import { createNotifyMember, createNotifyMembers, type NotificationBatchDependencies } from './notificationDelivery.ts'
import type { VapidKeys, WebPushResult, WebPushSubscription } from './webPush.ts'
import { createWebPushFanout, type WebPushFanoutMessage, webPushPayload } from './webPushDelivery.ts'

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const KEYS: VapidKeys = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@pancake.test' }
const sub = (userId: string, endpoint: string) => ({ user_id: userId, endpoint, p256dh: 'p', auth: 'a' })
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
      pruned = endpoints
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
  assert((sent[0].payload as { url: string }).url === '/trades', 'trade push should open the trades tab')
})

Deno.test('web push fanout is a no-op without VAPID keys and never throws', async () => {
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
  assert(idle.sent === 0 && !looked, 'disabled fanout should not query subscriptions')

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

Deno.test('web push payload maps categories to in-app routes', () => {
  assert(webPushPayload(message('u', { category: 'waiver' })).url === '/roster', 'waiver url')
  assert(webPushPayload(message('u', { category: 'draft' })).url === '/draft-room', 'draft url')
  assert(webPushPayload(message('u', { category: 'activity' })).url === '/', 'activity url')
})

const preferences = { trade_enabled: true, waiver_enabled: false, draft_enabled: true, activity_enabled: true }

Deno.test('notifyMember sends web push even when the member has no Expo token', async () => {
  const web: WebPushFanoutMessage[][] = []
  const notify = createNotifyMember({
    member: async () => ({ data: { user_id: 'user-a' }, error: null }),
    preferences: async () => ({ data: preferences, error: null }),
    profile: async () => ({ data: { push_token: null }, error: null }),
    send: async () => { throw new Error('Expo should not be called') },
    pushUrl: 'https://push.invalid/send',
    webPush: async (messages) => {
      web.push(messages)
      return { sent: messages.length, pruned: 0, failed: 0 }
    },
  })

  const delivered = await notify('member-a', 'Week 3 Final', 'You won', undefined, 'activity')
  assert(delivered.status === 'skipped', 'Expo result should still report the missing token')
  assert(web.length === 1 && web[0][0].userId === 'user-a' && web[0][0].title === 'Week 3 Final', 'web push not sent')

  const suppressed = await notify('member-a', 'Claim failed', 'Nope', undefined, 'waiver')
  assert(suppressed.status === 'skipped' && web.length === 1, 'disabled category must not reach web push')
})

Deno.test('notifyMembers fans out web push alongside Expo and preserves Expo results', async () => {
  const web: WebPushFanoutMessage[] = []
  const dependencies: NotificationBatchDependencies = {
    members: async () => ({ data: [{ id: 'member-a', user_id: 'user-a' }, { id: 'member-b', user_id: 'user-b' }], error: null }),
    preferences: async () => ({ data: [{ user_id: 'user-a', ...preferences }, { user_id: 'user-b', ...preferences }], error: null }),
    profiles: async () => ({ data: [{ id: 'user-a', push_token: 'ExponentPushToken[a]' }, { id: 'user-b', push_token: null }], error: null }),
    send: async () => Response.json({ data: [{ status: 'ok', id: 'ticket-a' }] }),
    pushUrl: 'https://push.invalid/send',
    webPush: async (messages) => {
      web.push(...messages)
      return { sent: messages.length, pruned: 0, failed: 0 }
    },
  }
  const results = await createNotifyMembers(dependencies)([
    { memberId: 'member-a', title: 'Offer', body: 'New trade offer', category: 'trade' },
    { memberId: 'member-b', title: 'Offer', body: 'New trade offer', category: 'trade' },
    { memberId: 'member-b', title: 'Waiver', body: 'Claim failed', category: 'waiver' },
  ])

  assert(web.map((entry) => entry.userId).join() === 'user-a,user-b', `unexpected web recipients ${JSON.stringify(web)}`)
  const byMember = new Map(results.map((result) => [`${result.memberId}:${result.status}`, result]))
  assert(byMember.get('member-a:sent')?.status === 'sent', 'Expo ticket result lost')
  assert(results.filter((result) => result.status === 'skipped').length === 2, 'skip results changed')
})

Deno.test('notifyMembers still awaits web push when Expo delivery throws', async () => {
  let finished = false
  const dependencies: NotificationBatchDependencies = {
    members: async () => ({ data: [{ id: 'member-a', user_id: 'user-a' }], error: null }),
    preferences: async () => ({ data: [], error: null }),
    profiles: async () => ({ data: [{ id: 'user-a', push_token: 'ExponentPushToken[a]' }], error: null }),
    send: async () => { throw new Error('connection reset') },
    pushUrl: 'https://push.invalid/send',
    webPush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      finished = true
      return { sent: 1, pruned: 0, failed: 0 }
    },
  }
  let threw = false
  try {
    await createNotifyMembers(dependencies)([{ memberId: 'member-a', title: 'T', body: 'B' }])
  } catch {
    threw = true
  }
  assert(threw, 'Expo failure should still propagate for outbox retry')
  assert(finished, 'web push was abandoned when Expo failed')
})
