import { supabase } from '../lib/supabase'
import { fetchSeasonSchedule, isRegularSeasonGameId } from '../lib/nba'

// Syncs the scheduled tip-off time (game_time) for all games in the season
// from the NBA CDN static schedule. Run once per season and after schedule changes.
export async function syncGameTimes(): Promise<{ updated: number }> {
    const games = await fetchSeasonSchedule()

    // Build candidate rows (skip entries missing required keys; same as before).
    const candidates = games
        .filter((g) => g.startedAt && isRegularSeasonGameId(g.gameId))
        .map((g) => ({
            nba_game_id: g.gameId,
            game_time: new Date(g.startedAt as string).toISOString(),
        }))

    if (candidates.length === 0) {
        console.log(`[schedule] Updated game_time for 0 games`)
        return { updated: 0 }
    }

    // Preserve original behavior: only update rows that already exist.
    // (Original .update().eq() silently no-ops for missing rows.)
    // Doing one SELECT + chunked UPSERTs replaces N per-row UPDATEs.
    const candidateIds = candidates.map((r) => r.nba_game_id)
    const existing = new Set<string>()
    const SELECT_CHUNK = 500
    for (let i = 0; i < candidateIds.length; i += SELECT_CHUNK) {
        const slice = candidateIds.slice(i, i + SELECT_CHUNK)
        const { data, error } = await supabase
            .from('nba_games')
            .select('nba_game_id')
            .in('nba_game_id', slice)
        if (error || !data) continue
        for (const row of data) {
            if (row.nba_game_id) existing.add(row.nba_game_id)
        }
    }

    const rows = candidates.filter((r) => existing.has(r.nba_game_id))

    let updated = 0
    const UPSERT_CHUNK = 500
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK)
        // Cast to any: generated type requires full row, but PostgREST accepts
        // partial payloads for the UPDATE path of an upsert when the row exists.
        const { error } = await supabase
            .from('nba_games')
            .upsert(chunk as any, { onConflict: 'nba_game_id' })
        if (!error) updated += chunk.length
    }

    console.log(`[schedule] Updated game_time for ${updated} games`)
    return { updated }
}
