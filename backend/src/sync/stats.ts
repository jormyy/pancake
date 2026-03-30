import { supabase, fetchAllPlayers } from '../lib/supabase'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from '../lib/nba'
import { todayET } from './livePoller'

// Normalize a player name for fuzzy matching:
// strips accents (ć→c), suffixes (Jr, Sr, II–IV), punctuation, and extra spaces
function normalizeName(name: string): string {
    return name
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
        .toLowerCase()
        .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '')
        .replace(/['.'\-]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

export interface StatRow {
    player_id: string
    game_id: string
    season_year: number
    week_number: number | null
    minutes_played: number | null
    points: number
    rebounds: number
    offensive_rebounds: number | null
    defensive_rebounds: number | null
    assists: number
    steals: number
    blocks: number
    turnovers: number | null
    personal_fouls: number | null
    field_goals_made: number | null
    field_goals_attempted: number | null
    three_pointers_made: number | null
    three_pointers_attempted: number | null
    free_throws_made: number | null
    free_throws_attempted: number | null
    plus_minus: number | null
    double_double: boolean
    triple_double: boolean
    did_not_play: boolean
    updated_at: string
}

// Shared stat-row builder — used by both syncStatsByDate and the backfill module
export function buildStatRow(
    p: NBABoxScorePlayer,
    playerId: string,
    gameId: string,
    seasonYear: number,
    weekNumber: number | null,
): StatRow {
    const s = p.statistics
    const minutesPlayed = parseNBAMinutes(s.minutes)
    const dnp = !minutesPlayed || minutesPlayed < 0.5

    const reb = s.reboundsTotal ?? 0
    const ast = s.assists ?? 0
    const pts = s.points ?? 0
    const stl = s.steals ?? 0
    const blk = s.blocks ?? 0

    const statCats = [pts >= 10, reb >= 10, ast >= 10, stl >= 10, blk >= 10].filter(Boolean).length

    return {
        player_id: playerId,
        game_id: gameId,
        season_year: seasonYear,
        week_number: weekNumber,
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
        double_double: statCats >= 2,
        triple_double: statCats >= 3,
        did_not_play: dnp,
        updated_at: new Date().toISOString(),
    }
}

export async function syncStatsByDate(date: Date) {
    // Use ET date — NBA game_date values are ET-based, and UTC rolls over ~4-5h before midnight ET
    const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    console.log(`[sync] Fetching stats for ${dateStr}...`)

    const isPast = dateStr < new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    // Get games for this date that have an nba_game_id.
    // For past dates, include Scheduled games too — they may just have a stale status.
    const query = supabase
        .from('nba_games')
        .select('id, nba_game_id, week_number, season_year, status')
        .eq('game_date', dateStr)
        .not('nba_game_id', 'is', null)
    if (!isPast) query.neq('status', 'Scheduled')

    const { data: games, error: gErr } = await query

    if (gErr) throw gErr
    if (!games?.length) {
        console.log(`[sync] No completed/live games for ${dateStr}.`)
        return
    }

    // Load player lookup maps — paginated to avoid PostgREST max_rows cap
    const players = await fetchAllPlayers()

    const byNbaId = new Map<string, string>() // nba personId → player.id
    const byName = new Map<string, string>() // display_name lower → player.id
    const byNormName = new Map<string, string>() // normalized name → player.id
    for (const p of players) {
        if (p.nba_id) byNbaId.set(p.nba_id, p.id)
        const lower = p.display_name.toLowerCase()
        byName.set(lower, p.id)
        byNormName.set(normalizeName(lower), p.id)
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
                    const nameLower = (p.name ?? '').toLowerCase()
                    playerId = byName.get(nameLower) ?? byNormName.get(normalizeName(nameLower))
                    if (playerId && !byNbaId.has(personId)) {
                        nbaIdUpdates.push({ id: playerId, nba_id: personId })
                        byNbaId.set(personId, playerId)
                    }
                    if (!playerId) {
                        console.log(`[sync] Unmatched player: "${p.name}" (personId ${personId})`)
                    }
                }

                if (!playerId) continue

                if (!p.statistics) continue

                stats.push(buildStatRow(p, playerId, game.id, game.season_year, game.week_number))
            }

            // For past dates: skip games the box score says haven't started yet
            if (isPast && boxScore.gameStatus === 1) continue

            if (boxScore.gameStatus === 3 && game.status !== 'Final') {
                await supabase.from('nba_games').update({ status: 'Final' }).eq('id', game.id)
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

    // Clear stale transient injury statuses for players who actually played today.
    // If a player was listed Out/GTD/Doubtful/Questionable but has non-DNP stats,
    // their status is clearly stale — clear it so the UI stays consistent.
    // IR is intentionally excluded: it's a roster designation, not a game-day tag.
    // Collect player IDs that played today (did_not_play = false) and have an injury status
    const { data: playedWithInjury } = await supabase
        .from('player_game_stats')
        .select('player_id, players!inner(injury_status)')
        .eq('did_not_play', false)
        .in('game_id', games.map((g) => g.id))
        .not('players.injury_status', 'is', null)
        .not('players.injury_status', 'like', 'IR%')
    const stalePlayers = (playedWithInjury ?? []).map((r: any) => r.player_id)
    if (stalePlayers.length > 0) {
        await supabase
            .from('players')
            .update({ injury_status: null })
            .in('id', stalePlayers)
        console.log(`[sync] Cleared stale injury status for ${stalePlayers.length} player(s) who played on ${dateStr}.`)
    }

    console.log(`[sync] Upserted ${statCount} stat lines for ${dateStr}.`)
}
