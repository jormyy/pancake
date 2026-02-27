import { supabase } from '../lib/supabase'
import { fetchProjectionsByDate, formatDate } from '../lib/sportsdata'

export async function syncProjectionsByDate(date: Date) {
    const dateStr = formatDate(date)
    console.log(`[sync] Fetching projections for ${dateStr}...`)

    const raw = await fetchProjectionsByDate(dateStr)
    if (!raw || raw.length === 0) {
        console.log(`[sync] No projections for ${dateStr}.`)
        return
    }

    // Resolve week number from nba_games
    const sdGameIds = [...new Set(raw.map((s: any) => String(s.GameID)))]
    const { data: games, error: gErr } = await supabase
        .from('nba_games')
        .select('sportsdata_game_id, week_number, season_year')
        .in('sportsdata_game_id', sdGameIds)

    if (gErr) throw gErr

    const gameMap = Object.fromEntries((games ?? []).map((g) => [g.sportsdata_game_id, g]))

    // Resolve player IDs
    const sdPlayerIds = [...new Set(raw.map((s: any) => String(s.PlayerID)))]
    const { data: players, error: pErr } = await supabase
        .from('players')
        .select('id, sportsdata_id')
        .in('sportsdata_id', sdPlayerIds)

    if (pErr) throw pErr

    const playerMap = Object.fromEntries((players ?? []).map((p) => [p.sportsdata_id, p.id]))

    const projections = raw
        .map((s: any) => {
            const game = gameMap[String(s.GameID)]
            const playerId = playerMap[String(s.PlayerID)]
            if (!game || !playerId) return null

            return {
                player_id: playerId,
                season_year: game.season_year,
                week_number: game.week_number,
                projected_points: s.FantasyPoints ?? null,
                projected_minutes: s.Minutes ?? null,
                fetched_at: new Date().toISOString(),
            }
        })
        .filter(Boolean)

    if (projections.length === 0) return

    const { error } = await supabase
        .from('player_projections')
        .upsert(projections, { onConflict: 'player_id,season_year,week_number' })

    if (error) throw error
    console.log(`[sync] Upserted ${projections.length} projections for ${dateStr}.`)
}
