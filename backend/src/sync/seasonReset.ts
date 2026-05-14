import { supabase } from '../lib/supabase'

type AdvanceSeasonRow = {
    new_season_id: string
    new_year: number
}

// Creates the next league season, carries roster state, extends the pick bank,
// reseeds waivers, and flips league status in one database transaction.
export async function advanceSeason(leagueId: string) {
    const { data, error } = await supabase.rpc('advance_season_atomic', {
        p_league_id: leagueId,
    })

    if (error) throw error

    const row = Array.isArray(data) ? data[0] as AdvanceSeasonRow | undefined : null
    if (!row) throw new Error('Season reset did not return a new season')

    console.log(`[seasonReset] League ${leagueId} advanced to ${row.new_year}`)
    return { newSeasonId: row.new_season_id, newYear: row.new_year }
}
