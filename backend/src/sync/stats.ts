import { supabase } from '../lib/supabase'
import { fetchBoxScore, parseNBAMinutes } from '../lib/nba'

export async function syncStatsRange(days: number) {
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        await syncStatsByDate(d)
    }
}

export async function syncStatsByDate(date: Date) {
    const dateStr = date.toISOString().split('T')[0] // YYYY-MM-DD
    console.log(`[sync] Fetching stats for ${dateStr}...`)

    // Get games for this date that have an nba_game_id and are in-progress or final
    const { data: games, error: gErr } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, week_number, season_year, status')
        .eq('game_date', dateStr)
        .not('nba_game_id', 'is', null)
        .in('status', ['InProgress', 'Final'])

    if (gErr) throw gErr
    if (!games?.length) {
        console.log(`[sync] No completed/live games for ${dateStr}.`)
        return
    }

    // Load player lookup maps
    const { data: players, error: pErr } = await supabase
        .from('players')
        .select('id, display_name, nba_id')
    if (pErr) throw pErr

    const byNbaId = new Map<string, string>() // nba personId → player.id
    const byName = new Map<string, string>() // display_name lower → player.id
    for (const p of players ?? []) {
        if (p.nba_id) byNbaId.set(p.nba_id, p.id)
        byName.set(p.display_name.toLowerCase(), p.id)
    }

    let statCount = 0
    const nbaIdUpdates: { id: string; nba_id: string }[] = []

    for (const game of games) {
        try {
            const boxScore = await fetchBoxScore(game.nba_game_id!)
            const allPlayers = [
                ...(boxScore.homeTeam?.players ?? []),
                ...(boxScore.awayTeam?.players ?? []),
            ]

            const stats: any[] = []

            for (const p of allPlayers) {
                const personId = String(p.personId)
                let playerId = byNbaId.get(personId)

                if (!playerId) {
                    // Fall back to name matching and save nba_id for future use
                    const nameLower = (p.name ?? '').toLowerCase()
                    playerId = byName.get(nameLower)
                    if (playerId && !byNbaId.has(personId)) {
                        nbaIdUpdates.push({ id: playerId, nba_id: personId })
                        byNbaId.set(personId, playerId)
                    }
                }

                if (!playerId) continue

                const s = p.statistics
                if (!s) continue

                const minutesPlayed = parseNBAMinutes(s.minutes)
                const dnp = !minutesPlayed || minutesPlayed < 0.5

                const reb = s.reboundsTotal ?? 0
                const ast = s.assists ?? 0
                const pts = s.points ?? 0
                const stl = s.steals ?? 0
                const blk = s.blocks ?? 0

                // Compute double/triple double from this game's stats
                const statCats = [pts >= 10, reb >= 10, ast >= 10, stl >= 10, blk >= 10].filter(Boolean).length
                const doubleDouble = statCats >= 2
                const tripleDouble = statCats >= 3

                stats.push({
                    player_id: playerId,
                    game_id: game.id,
                    season_year: game.season_year,
                    week_number: game.week_number,
                    minutes_played: minutesPlayed,
                    points: pts,
                    rebounds: reb,
                    offensive_rebounds: s.reboundsOffensive ?? null,
                    defensive_rebounds: s.reboundsDefensive ?? null,
                    assists: ast,
                    steals: stl,
                    blocks: blk,
                    turnovers: s.turnovers ?? null,
                    personal_fouls: s.foulsPersonal ?? null,
                    field_goals_made: s.fieldGoalsMade ?? null,
                    field_goals_attempted: s.fieldGoalsAttempted ?? null,
                    three_pointers_made: s.threePointersMade ?? null,
                    three_pointers_attempted: s.threePointersAttempted ?? null,
                    free_throws_made: s.freeThrowsMade ?? null,
                    free_throws_attempted: s.freeThrowsAttempted ?? null,
                    plus_minus: s.plusMinusPoints ?? null,
                    double_double: doubleDouble,
                    triple_double: tripleDouble,
                    did_not_play: dnp,
                    updated_at: new Date().toISOString(),
                })
            }

            if (stats.length) {
                const { error } = await supabase
                    .from('player_game_stats')
                    .upsert(stats, { onConflict: 'player_id,game_id' })
                if (error) throw error
                statCount += stats.length
            }
        } catch (e: any) {
            console.error(`[sync] Error fetching box score for ${game.nba_game_id}:`, e.message)
        }
    }

    // Persist newly discovered nba_id mappings in batches
    for (const u of nbaIdUpdates) {
        await supabase.from('players').update({ nba_id: u.nba_id }).eq('id', u.id)
    }
    if (nbaIdUpdates.length > 0) {
        console.log(`[sync] Mapped ${nbaIdUpdates.length} new NBA person IDs.`)
    }

    console.log(`[sync] Upserted ${statCount} stat lines for ${dateStr}.`)
}
