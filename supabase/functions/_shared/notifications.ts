import { supabase } from './supabase.ts'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

export async function notifyMember(
  memberId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const { data: member } = await supabase
    .from('league_members')
    .select('user_id')
    .eq('id', memberId)
    .single()
  if (!member) return
  await notifyUser((member as any).user_id, title, body, data)
}

export async function notifyUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', userId)
    .single()
  const token = (profile as any)?.push_token
  if (!token) return

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: token, title, body, data: data ?? {}, sound: 'default' }),
    })
    const json = await res.json() as any
    if (json?.data?.status === 'error') {
      console.error('[push]', json?.data?.message)
    }
  } catch (e) {
    console.error('[push] Failed to send:', e)
  }
}
