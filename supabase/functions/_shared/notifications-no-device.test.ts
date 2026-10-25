import { strict as assert } from 'node:assert'
import { deliverNotificationOutbox, drainNotificationOutbox, type NotificationOutboxRow } from '../process-trades/outbox.ts'

let subscriptionReads = 0
let subscribed = false
const backend = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, req => {
  const path = new URL(req.url).pathname
  if (path.endsWith('/league_members')) return Response.json([{ id: 'member', user_id: 'user' }])
  if (path.endsWith('/notification_preferences')) return Response.json([])
  if (path.endsWith('/profiles')) return Response.json([{ id: 'user', push_token: null }])
  if (path.endsWith('/web_push_subscriptions')) { subscriptionReads++; return Response.json(subscribed ? [{ endpoint: 'https://push.example.test/member' }] : []) }
  if (path.endsWith('/rpc/notif_admit_delivery_atomic')) return Response.json(true)
  throw new Error(`Unexpected notification request: ${path}`)
})
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(backend.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { notifyMembers } = await import('./notifications.ts')

Deno.test({ name: 'production notification reservations skip absent devices and drain later rows', sanitizeOps: false, sanitizeResources: false, fn: async () => {
  try {
    for (const configured of [false, true]) {
      for (const name of ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_VAPID_SUBJECT']) {
        if (configured) Deno.env.set(name, 'test')
        else Deno.env.delete(name)
      }
      const rows: NotificationOutboxRow[] = Array.from({ length: 11 }, (_, index) => ({
        id: `${index}`, claim_token: 'claim', member_id: 'member', title: 'Update', body: 'Update', data: {}, category: 'activity',
      }))
      const delivery = await notifyMembers([{ memberId: 'member', title: 'Update', body: 'Update', delivery: { id: 'probe', claimToken: 'claim' } }])
      assert.deepEqual(delivery, [{ memberId: 'member', status: 'skipped', reason: 'no_device' }])
      let completed = 0
      const result = await drainNotificationOutbox(async () => rows.splice(0, 10), batch => deliverNotificationOutbox(
        batch, notifyMembers, async () => { completed++ }, async () => { throw new Error('No device must not retry') },
        async () => { throw new Error('No device must not dead-letter') },
      ))
      assert.equal(completed, 11)
      assert.deepEqual(result, { delivered: 0, failed: 0, discarded: 11, deadLettered: 0 })
    }
    subscribed = true
    for (const name of ['WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'WEB_PUSH_VAPID_SUBJECT']) Deno.env.delete(name)
    assert.deepEqual(await notifyMembers([{ memberId: 'member', title: 'Update', body: 'Update', delivery: { id: 'probe', claimToken: 'claim' } }]),
      [{ memberId: 'member', status: 'failed', retryable: true, error: 'Web push is not configured' }])
    assert.equal(subscriptionReads, 25)
  } finally { await backend.shutdown() }
} })
