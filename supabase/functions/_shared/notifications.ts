import { supabase } from './supabase.ts'
import { createNotifyMember, createNotifyMembers } from './notificationDelivery.ts'
import type { VapidKeys } from './webPush.ts'
import { createWebPushFanout } from './webPushDelivery.ts'

export type { NotificationMessage, NotifyMembers } from './notificationDelivery.ts'

const EXPO_PUSH_URL = Deno.env.get('EXPO_PUSH_URL') ?? 'https://exp.host/--/api/v2/push/send'

/** VAPID credentials for PWA push; null (web push disabled) until all three secrets are set. */
export function webPushVapidKeys(): VapidKeys | null {
  const publicKey = Deno.env.get('WEB_PUSH_VAPID_PUBLIC_KEY')?.trim()
  const privateKey = Deno.env.get('WEB_PUSH_VAPID_PRIVATE_KEY')?.trim()
  const subject = Deno.env.get('WEB_PUSH_VAPID_SUBJECT')?.trim()
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

export async function pruneWebPushSubscriptions(endpoints: string[]) {
  const { error } = await supabase.from('web_push_subscriptions').delete().in('endpoint', endpoints)
  return { error }
}

export const webPushFanout = createWebPushFanout({
  vapid: webPushVapidKeys,
  subscriptions: async (userIds) => {
    const { data, error } = await supabase
      .from('web_push_subscriptions')
      .select('user_id, endpoint, p256dh, auth')
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
  profile: async (userId) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('push_token')
      .eq('id', userId)
      .single()
    return { data, error }
  },
  send: (url, init) => fetch(url, init),
  pushUrl: EXPO_PUSH_URL,
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
  profiles: async (userIds) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, push_token')
      .in('id', userIds)
    return { data, error }
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
