import { supabase } from './supabase.ts'

const EXPO_PUSH_URL = Deno.env.get('EXPO_PUSH_URL') ?? 'https://exp.host/--/api/v2/push/send'
export type NotificationCategory = 'trade' | 'waiver' | 'draft' | 'activity'
type ExpoPushResponse = { data?: { status?: string; message?: string } }
type NotificationPreferenceColumn = 'trade_enabled' | 'waiver_enabled' | 'draft_enabled' | 'activity_enabled'
const preferenceColumns: Record<NotificationCategory, NotificationPreferenceColumn> = {
  trade: 'trade_enabled',
  waiver: 'waiver_enabled',
  draft: 'draft_enabled',
  activity: 'activity_enabled',
}

export async function notifyMember(
  memberId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  category: NotificationCategory = 'activity',
): Promise<void> {
  const { data: member } = await supabase
    .from('league_members')
    .select('user_id')
    .eq('id', memberId)
    .single()
  if (!member) return
  await notifyUser(member.user_id, title, body, data, category)
}

async function notifyUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  category: NotificationCategory = 'activity',
): Promise<void> {
  const preferenceColumn = preferenceColumns[category]
  const { data: preferences } = await supabase
    .from('notification_preferences')
    .select('trade_enabled, waiver_enabled, draft_enabled, activity_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  if (preferences?.[preferenceColumn] === false) return

  const { data: profile } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', userId)
    .single()
  const token = profile?.push_token
  if (!token) return

  // Expo push API typically responds in <500ms; 8s is a generous upper bound.
  // Fail-soft: never let a slow/hanging Expo response stall the edge function
  // (one slow call per matchup could chew through the 150s budget).
  const PUSH_TIMEOUT_MS = 8000
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: token, title, body, data: data ?? {}, sound: 'default' }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    const json = await res.json() as ExpoPushResponse
    if (json?.data?.status === 'error') {
      console.error('[push]', json?.data?.message)
    }
  } catch (e) {
    // Catches AbortError (timeout) and any network/JSON errors. Fail-soft.
    console.error('[push] Failed to send:', e)
  }
}
