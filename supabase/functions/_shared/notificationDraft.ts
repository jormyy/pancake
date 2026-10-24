import { supabase } from './supabase.ts'

export async function queueRookiePickNotification(draftId: string, memberId: string, playerId: string, pickId: string) {
  const { error } = await supabase.from('notification_outbox').upsert({
    dedupe_key: `rookie-pick:${pickId}:${memberId}`,
    member_id: memberId,
    event_type: 'rookie_draft_pick',
    title: 'Rookie Draft Pick Made',
    body: 'A player has been added to your roster.',
    data: { draftId, playerId, pickId },
    category: 'draft',
  }, { onConflict: 'dedupe_key', ignoreDuplicates: true })
  if (error) throw error
}
