import { supabase } from './supabase.ts'
import { createNotifyMember, createNotifyMembers } from './notificationDelivery.ts'

export type { NotificationMessage, NotifyMember, NotifyMembers } from './notificationDelivery.ts'

const EXPO_PUSH_URL = Deno.env.get('EXPO_PUSH_URL') ?? 'https://exp.host/--/api/v2/push/send'

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
  send: (url, init) => fetch(url, init),
  pushUrl: EXPO_PUSH_URL,
})
