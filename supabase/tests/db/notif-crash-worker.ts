import { strict as assert } from 'node:assert'
import { supabase } from '../../functions/_shared/supabase.ts'
import { notifyMembers } from '../../functions/_shared/notifications.ts'
import { normalizeNotificationPreferences } from '../../functions/_shared/notificationsPreferences.ts'
import { createNotifyMembers } from '../../functions/_shared/notificationDelivery.ts'
import { deliverTradeNotificationOutbox } from '../../functions/process-trades/outbox.ts'
import { settleTradeNotificationReceipts } from '../../functions/process-trades/receipts.ts'

const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
const api = new URL(Deno.env.get('SUPABASE_URL')!)
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(api.hostname) && Number(api.port) === Number(port) - 1)
const [phase, transport, id] = Deno.args
const fake = Deno.env.get('EXPO_PUSH_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(fake).hostname))
async function barrier(name: string) {
  if (phase !== name) return
  console.log('CRASH_WINDOW ' + name)
  await new Promise(() => { setInterval(() => {}, 1000) })
}
async function result<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await query
  if (error) throw error
  return data
}
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.href === fake) await barrier('expo_before_network')
  if (url.pathname.endsWith('/record_notification_outbox_ticket_atomic')) await barrier('expo_after_acceptance')
  const response = await nativeFetch(input, init)
  if (url.pathname.endsWith('/record_notification_outbox_ticket_atomic')) await barrier('expo_after_ticket')
  return response
}
const webNotify = createNotifyMembers({
  members: async ids => supabase.from('league_members').select('id,user_id').in('id', ids),
  preferences: async ids => {
    const { data, error } = await supabase.from('notification_preferences').select('*').in('user_id', ids)
    return { data: data?.map(row => ({ user_id: row.user_id, ...normalizeNotificationPreferences(row) })) ?? null, error }
  },
  profiles: async () => ({ data: [], error: null }),
  admitDelivery: async message => await result(supabase.rpc('notif_admit_delivery_atomic', { p_id: message.delivery!.id, p_claim_token: message.delivery!.claimToken })) === true,
  beginWebDelivery: async message => {
    await barrier('web_before_reservation')
    const state = await result(supabase.rpc('notif_begin_web_atomic', { p_id: message.delivery!.id, p_claim_token: message.delivery!.claimToken }))
    assert.ok(state === 'send' || state === 'attempted' || state === 'delivered')
    if (state === 'send') await barrier('web_after_reservation')
    return state
  },
  finishWebDelivery: async (message, sent) => {
    assert.equal(await result(supabase.rpc('notif_finish_web_atomic', { p_id: message.delivery!.id, p_claim_token: message.delivery!.claimToken, p_sent: sent })), true)
    await barrier('web_after_finish')
  },
  webPush: async messages => {
    const response = await fetch(new URL('/web', fake), { method: 'POST', body: JSON.stringify(messages) })
    assert.equal(response.status, 200)
    await barrier('web_after_acceptance')
    return { sent: 1, failed: 0, pruned: 0 }
  },
  send: () => { throw new Error('Web-only scenario must not send Expo') },
  pushUrl: fake,
})
const rows = (await result(supabase.rpc('claim_notification_outbox_atomic', { p_limit: 200, p_lease_seconds: 60 })) ?? []).filter(row => row.id === id)
await deliverTradeNotificationOutbox(rows, transport === 'web' ? webNotify : notifyMembers,
  async () => { throw new Error('Production adapter must persist ticket immediately') },
  async row => { assert.equal(await result(supabase.rpc('complete_notification_outbox_atomic', { p_id: row.id, p_claim_token: row.claim_token })), true) },
  async (row, error) => { await result(supabase.rpc('fail_notification_outbox_atomic', { p_id: row.id, p_claim_token: row.claim_token, p_error: error })) },
  async () => { throw new Error('No terminal transport errors expected') })
const receipts = (await result(supabase.rpc('claim_notification_receipts_atomic', { p_limit: 200, p_lease_seconds: 60 })) ?? []).filter(row => row.id === id)
if (receipts.length) {
  const response = await fetch(new URL('/receipts', fake), { method: 'POST', body: JSON.stringify({ ids: receipts.map(row => row.expo_ticket_id) }) })
  const payload = await response.json()
  await barrier('expo_after_receipt')
  await settleTradeNotificationReceipts(receipts, payload.data, {
    complete: async row => {
      assert.equal(await result(supabase.rpc('complete_notification_outbox_atomic', { p_id: row.id, p_claim_token: row.claim_token })), true)
      await barrier('expo_after_complete')
    },
    invalidate: async () => { throw new Error('No invalid tokens expected') },
    retry: async () => { throw new Error('No receipt errors expected') },
    defer: async () => { throw new Error('No deferred receipt expected') },
    deadLetter: async () => { throw new Error('No dead letters expected') },
  })
}
