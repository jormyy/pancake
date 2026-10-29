import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from './database.ts'
import { supabase } from './supabase.ts'

type NotificationDatabase = Database & {
  public: { Functions: { enqueue_rookie_pick_notification: {
    Args: { p_draft_id: string; p_member_id: string; p_player_id: string; p_pick_id: string }
    Returns: undefined
  } } }
}

export async function queueRookiePickNotification(draftId: string, memberId: string, playerId: string, pickId: string) {
  const { error } = await (supabase as SupabaseClient<NotificationDatabase>).rpc('enqueue_rookie_pick_notification', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_player_id: playerId,
    p_pick_id: pickId,
  })
  if (error) throw error
}
