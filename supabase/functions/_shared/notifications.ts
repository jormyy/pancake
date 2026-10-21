import { supabase } from './supabase.ts'
import { createNotifyMembers } from './notificationDelivery.ts'
import { normalizeNotificationPreferences } from './notificationsPreferences.ts'
import type { VapidKeys } from './webPush.ts'
import { createWebPushFanout, type WebPushSnapshot } from './webPushDelivery.ts'

export type { NotificationMessage, NotifyMembers } from './notificationDelivery.ts'


export async function suppressNotification(id: string, claimToken: string) {
  const { data, error } = await supabase.rpc('notif_suppress_atomic', { p_id: id, p_claim_token: claimToken })
  if (error) throw error
  if (!data) throw new Error('Notification lease lost before suppression')
}

async function admitNotification(id: string, claimToken: string) {
  const { data, error } = await supabase.rpc('notif_admit_delivery_atomic', { p_id: id, p_claim_token: claimToken })
  if (error) throw error
  return data === true
}

const EXPO_PUSH_URL = Deno.env.get('EXPO_PUSH_URL') ?? 'https://exp.host/--/api/v2/push/send'

/** VAPID credentials for PWA push; null (web push disabled) until all three secrets are set. */
export function webPushVapidKeys(): VapidKeys | null {
  const publicKey = Deno.env.get('WEB_PUSH_VAPID_PUBLIC_KEY')?.trim()
  const privateKey = Deno.env.get('WEB_PUSH_VAPID_PRIVATE_KEY')?.trim()
  const subject = Deno.env.get('WEB_PUSH_VAPID_SUBJECT')?.trim()
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

export async function pruneWebPushSubscriptions(subscriptions: WebPushSnapshot[]) {
  let count = 0
  for (const subscription of subscriptions) {
    const result = await supabase.from('web_push_subscriptions').delete({ count: 'exact' })
      .eq('endpoint', subscription.endpoint).eq('user_id', subscription.user_id).eq('updated_at', subscription.updated_at)
    if (result.error) return { error: result.error, count }
    count += result.count ?? 0
  }
  return { error: null, count }
}

export const webPushFanout = createWebPushFanout({
  vapid: webPushVapidKeys,
  subscriptions: async (userIds) => {
    const { data, error } = await supabase
      .from('web_push_subscriptions')
      .select('user_id, endpoint, p256dh, auth, updated_at')
      .in('user_id', userIds)
    return { data, error }
  },
  prune: pruneWebPushSubscriptions,
})

export const notifyMembers = createNotifyMembers({
  admitDelivery: (message) => admitNotification(message.delivery!.id, message.delivery!.claimToken),
  members: async (memberIds) => {
    const { data, error } = await supabase
      .from('league_members')
      .select('id, user_id')
      .in('id', memberIds)
    return { data, error }
  },
  preferences: async (userIds) => {
    const { data, error } = await supabase
      .from('notification_preferences')
      .select('*')
      .in('user_id', userIds)
    return { data: data?.map(row => ({ user_id: row.user_id, ...normalizeNotificationPreferences(row) })) ?? null, error }
  },
  profiles: async (userIds) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, push_token')
      .in('id', userIds)
    return { data, error }
  },
  beginWebDelivery: async (message, userId) => {
    if (!webPushVapidKeys()) return 'attempted'
    const subscriptions = await supabase.from('web_push_subscriptions').select('endpoint').eq('user_id', userId).limit(1)
    if (subscriptions.error) throw subscriptions.error
    if (!subscriptions.data?.length) return 'attempted'
    const { data, error } = await supabase.rpc('notif_begin_web_atomic', {
      p_id: message.delivery!.id, p_claim_token: message.delivery!.claimToken,
    })
    if (error) throw error
    if (data !== 'send' && data !== 'delivered' && data !== 'attempted') throw new Error('Notification web lease lost')
    return data
  },
  finishWebDelivery: async (message, sent) => {
    const { data, error } = await supabase.rpc('notif_finish_web_atomic', {
      p_id: message.delivery!.id, p_claim_token: message.delivery!.claimToken, p_sent: sent,
    })
    if (error) throw error
    if (!data) throw new Error('Notification web outcome persistence failed')
  },
  invalidateToken: async (userId, token) => {
    const { data, error } = await supabase.rpc('clear_push_token_for_user_atomic', {
      p_user_id: userId,
      p_token: token,
    })
    return { data: data ?? false, error }
  },
  send: (url, init) => fetch(url, init),
  pushUrl: EXPO_PUSH_URL,
  webPush: webPushFanout,
})
