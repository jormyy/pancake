import { supabase, fetchAllPlayers } from '../lib/supabase'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from '../lib/nba'
import { todayET, toETDate } from '../lib/utils/date'
import { AMBIGUOUS_PLAYER_ID, buildPlayerLookupMaps, lookupPlayerByName, normalizeName } from '../lib/utils/nameMatch'
import { persistNbaIdUpdates } from '../lib/playerIdentity'

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
    const dnp = minutesPlayed == null

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
    const dateStr = toETDate(date)
    console.log(`[sync] Fetching stats for ${dateStr}...`)

    const isPast = dateStr < todayET()

    // Get regular-season games for this date that have an nba_game_id.
    // For past dates, include Scheduled games too — they may just have a stale status.
    const query = supabase
        .from('nba_games')
        .select('id, nba_game_id, week_number, season_year, status')
        .eq('game_date', dateStr)
        .like('nba_game_id', '002%')
    if (!isPast) query.neq('status', 'Scheduled')

    const { data: games, error: gErr } = await query

    if (gErr) throw gErr
    if (!games?.length) {
        console.log(`[sync] No completed/live games for ${dateStr}.`)
        return
    }

    // Load player lookup maps — paginated to avoid PostgREST max_rows cap
    const players = await fetchAllPlayers()

    const playerLookup = buildPlayerLookupMaps(players)
    const byNbaId = playerLookup.byNbaId

    let statCount = 0
    const nbaIdUpdates: { id: string; nba_id: string }[] = []
    const syncFailures: string[] = []

    // Parallelize CDN box-score fetches in chunks. Each fetch is independent
    // (read-only HTTP GET), but downstream accumulation (nbaIdUpdates, DB writes)
    // is processed sequentially to preserve ordering and avoid race conditions.
    const FETCH_CONCURRENCY = 5
    type BoxScoreFetch =
        | { ok: true; game: typeof games[number]; boxScore: Awaited<ReturnType<typeof fetchBoxScore>> }
        | { ok: false; game: typeof games[number]; error: any }

    const fetched: BoxScoreFetch[] = []
    for (let i = 0; i < games.length; i += FETCH_CONCURRENCY) {
        const chunk = games.slice(i, i + FETCH_CONCURRENCY)
        const chunkResults = await Promise.all(
            chunk.map(async (game): Promise<BoxScoreFetch> => {
                try {
                    const boxScore = await fetchBoxScore(game.nba_game_id!)
                    return { ok: true, game, boxScore }
                } catch (error) {
                    return { ok: false, game, error }
                }
            }),
        )
        fetched.push(...chunkResults)
    }

    for (const result of fetched) {
        const { game } = result
        if (!result.ok) {
            console.error(`[sync] Error fetching box score for ${game.nba_game_id}:`, result.error?.message)
            syncFailures.push(`fetch ${game.nba_game_id}: ${result.error?.message ?? result.error}`)
            continue
        }
        try {
            const { boxScore } = result
            const allPlayers = [
                ...(boxScore.homeTeam?.players ?? []),
                ...(boxScore.awayTeam?.players ?? []),
            ]

            const stats: any[] = []

            for (const p of allPlayers) {
                const personId = String(p.personId)
                let playerId = byNbaId.get(personId)

                if (!playerId) {
                    playerId = resolveCdnPlayerForStats(playerLookup, personId, p.name ?? '') ?? undefined
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
                const { error: finalStatusError } = await supabase
                    .from('nba_games')
                    .update({ status: 'Final' })
                    .eq('id', game.id)
                if (finalStatusError) throw finalStatusError
            }

            if (stats.length) {
                const { error } = await supabase
                    .from('player_game_stats')
                    .upsert(stats, { onConflict: 'player_id,game_id' })
                if (error) throw error
                statCount += stats.length
            }
        } catch (e: any) {
            console.error(`[sync] Error processing box score for ${game.nba_game_id}:`, e.message)
            syncFailures.push(`process ${game.nba_game_id}: ${e.message}`)
        }
    }

    const persistedNbaIds = await persistNbaIdUpdates(nbaIdUpdates)
    if (nbaIdUpdates.length > 0) {
        console.log(`[sync] Mapped ${persistedNbaIds.updated} new NBA person IDs; merged ${persistedNbaIds.merged} duplicate rows before update.`)
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

    if (syncFailures.length > 0) {
        throw new Error(`[sync] Failed to sync ${syncFailures.length} game(s) for ${dateStr}: ${syncFailures.join('; ')}`)
    }

    console.log(`[sync] Upserted ${statCount} stat lines for ${dateStr}.`)
}

function resolveCdnPlayerForStats(
    playerLookup: ReturnType<typeof buildPlayerLookupMaps>,
    personId: string,
    displayName: string,
): string | null {
    const existingById = playerLookup.byNbaId.get(personId)
    if (existingById) return existingById

    const exact = playerLookup.byName.get(displayName.toLowerCase())
    if (exact && exact !== AMBIGUOUS_PLAYER_ID) return exact

    const normalized = playerLookup.byNormName.get(normalizeName(displayName))
    if (exact === AMBIGUOUS_PLAYER_ID || normalized === AMBIGUOUS_PLAYER_ID) {
        throw new Error(`Ambiguous CDN player name without NBA id: ${displayName}`)
    }

    return lookupPlayerByName(playerLookup, displayName)
}
