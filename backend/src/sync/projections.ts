import { supabase } from '../lib/supabase'
import { calculateFantasyPoints, getWeekNumberForDate } from '../lib/scoring'

// Standard scoring weights used for projection ranking (not league-specific)
// Players are ranked relative to each other, so absolute values don't matter
const STD_SCORING: Record<string, number> = {
    points: 1,
    rebounds: 1.2,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 1,
    field_goals_made: 0,
    field_goals_attempted: 0,
    free_throws_made: 0,
    free_throws_attempted: 0,
}

// Compute projected fantasy points from a rolling 4-week average of recent stats.
// Stored per-player per-week in player_projections for use in auto-set lineup.
export async function syncProjectionsByDate(_date: Date) {
    const today = new Date()
    const seasonYear = today.getMonth() >= 9 ? today.getFullYear() + 1 : today.getFullYear()
    const weekNumber = await getWeekNumberForDate(today, seasonYear)

    if (!weekNumber) {
        console.log('[projections] No current week found, skipping.')
        return
    }

    console.log(`[projections] Computing rolling averages for week ${weekNumber}...`)

    // Pull stats from the last 4 weeks (excluding did_not_play)
    const minWeek = Math.max(1, weekNumber - 3)

    const { data: stats, error } = await supabase
        .from('player_game_stats')
        .select(
            'player_id, points, rebounds, assists, steals, blocks, turnovers, ' +
                'three_pointers_made, field_goals_made, field_goals_attempted, ' +
                'free_throws_made, free_throws_attempted, did_not_play',
        )
        .eq('season_year', seasonYear)
        .gte('week_number', minWeek)
        .lte('week_number', weekNumber)

    if (error) throw error
    const rows = (stats ?? []) as any[]
    if (!rows.length) {
        console.log('[projections] No recent stats found.')
        return
    }

    // Group by player, skip DNP rows
    const playerGames = new Map<string, any[]>()
    for (const s of rows) {
        if (s.did_not_play) continue
        if (!playerGames.has(s.player_id)) playerGames.set(s.player_id, [])
        playerGames.get(s.player_id)!.push(s)
    }

    const projections: any[] = []
    for (const [playerId, games] of playerGames) {
        if (!games.length) continue
        const avg =
            games.reduce((sum, g) => sum + calculateFantasyPoints(g, STD_SCORING), 0) / games.length
        projections.push({
            player_id: playerId,
            season_year: seasonYear,
            week_number: weekNumber,
            projected_points: parseFloat(avg.toFixed(2)),
            fetched_at: new Date().toISOString(),
        })
    }

    if (!projections.length) return

    const CHUNK = 500
    for (let i = 0; i < projections.length; i += CHUNK) {
        const { error: upErr } = await supabase
            .from('player_projections')
            .upsert(projections.slice(i, i + CHUNK), { onConflict: 'player_id,season_year,week_number' })
        if (upErr) throw upErr
    }

    console.log(`[projections] Upserted ${projections.length} rolling-average projections.`)
}
