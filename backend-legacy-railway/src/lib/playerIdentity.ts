import { supabase } from './supabase'

export type NbaIdUpdate = { id: string; nba_id: string }

export async function persistNbaIdUpdates(updates: NbaIdUpdate[]): Promise<{ updated: number; merged: number }> {
    let updated = 0
    let merged = 0
    const seen = new Set<string>()

    for (const update of updates) {
        const key = `${update.id}:${update.nba_id}`
        if (seen.has(key)) continue
        seen.add(key)

        const { data: existingOwner, error: ownerError } = await supabase
            .from('players')
            .select('id')
            .eq('nba_id', update.nba_id)
            .maybeSingle()
        if (ownerError) throw ownerError

        if (existingOwner?.id && existingOwner.id !== update.id) {
            const { error: mergeError } = await supabase.rpc('merge_players', {
                winner_id: existingOwner.id,
                loser_id: update.id,
            })
            if (mergeError) throw mergeError
            merged++
            continue
        }

        const { error: updateError } = await supabase
            .from('players')
            .update({ nba_id: update.nba_id })
            .eq('id', update.id)
        if (updateError) throw updateError
        updated++
    }

    return { updated, merged }
}
