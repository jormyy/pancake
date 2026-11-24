import { supabase } from '@/lib/supabase'
import type { RosterPlayer } from '@/lib/roster'

export async function getRosterStatusChangeLockMessage(rosterPlayer: RosterPlayer | null | undefined): Promise<string | null> {
    if (!rosterPlayer) return null

    const { data, error } = await supabase.from('roster_players')
        .select('locked_until_slate_end')
        .eq('id', rosterPlayer.id)
        .maybeSingle()
    if (error) throw error
    if (!data?.locked_until_slate_end) return null

    return `${rosterPlayer.players.display_name}'s game has already started. IR and taxi changes are locked for today's slate.`
}
