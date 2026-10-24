import { supabase } from './supabase.ts'
import { createNotifyMember, createNotifyMembers } from './notificationDelivery.ts'
import type { VapidKeys } from './webPush.ts'
import { createWebPushFanout, type WebPushSnapshot } from './webPushDelivery.ts'

export type { NotificationMessage, NotifyMembers } from './notificationDelivery.ts'

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

export const notifyMember = createNotifyMember({
  member: async (memberId) => {
    const { data, error } = await supabase
      .from('league_members')
      .select('user_id')
      .eq('id', memberId)
      .single()
    return { data, error }
  },
  preferences: async (userId) => {
    const { data, error } = await supabase
      .from('notification_preferences')
      .select('trade_enabled, waiver_enabled, draft_enabled, activity_enabled')
      .eq('user_id', userId)
      .maybeSingle()
    return { data, error }
  },
  webPush: webPushFanout,
})

export const notifyMembers = createNotifyMembers({
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
      .select('user_id, trade_enabled, waiver_enabled, draft_enabled, activity_enabled')
      .in('user_id', userIds)
    return { data, error }
  },
  webPush: webPushFanout,
})
