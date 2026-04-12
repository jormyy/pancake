import { supabase } from '../lib/supabase'
import { fetchSeasonSchedule } from '../lib/nba'

// Syncs the scheduled tip-off time (game_time) for all games in the season
// from the NBA CDN static schedule. Run once per season and after schedule changes.
export async function syncGameTimes(): Promise<{ updated: number }> {
    const games = await fetchSeasonSchedule()
    let updated = 0

    for (const g of games) {
        if (!g.startedAt || !g.gameId) continue
        const { error } = await supabase
            .from('nba_games')
            .update({ game_time: new Date(g.startedAt).toISOString() })
            .eq('nba_game_id', g.gameId)
        if (!error) updated++
    }

    console.log(`[schedule] Updated game_time for ${updated} games`)
    return { updated }
}
