/**
 * Historical BBRef backfill — seasons 2003-04 through 2018-19
 *
 * NBA CDN box scores are unavailable (403) for these seasons.
 * We scrape basketball-reference.com for:
 *   1. Season schedule (game dates, teams, BBRef game IDs)
 *   2. Box score per game (player stats)
 *
 * Rate limit: 3s between requests to respect BBRef.
 */
import { supabase, fetchAllPlayers } from '../lib/supabase'
import { fetchBBRefSchedule, fetchBBRefBoxScore, BBRefPlayerStat } from '../lib/bbref'
import { sleep } from '../lib/utils/sleep'
import { buildPlayerLookupMaps, lookupPlayerByName } from '../lib/utils/nameMatch'

// BBRef seasons available: ending years 2004-2019 (2003-04 through 2018-19)
export const BBREF_SEASONS = Array.from({ length: 16 }, (_, i) => 2004 + i) // 2004..2019
type HistoricalSeasonResult = { completed: number; failed: number }

export async function syncBBRefSeason(seasonEndYear: number, jobId: string): Promise<HistoricalSeasonResult> {
    console.log(`[bbrefHistory] Starting season ${seasonEndYear - 1}-${seasonEndYear}`)

    // Load player lookup maps
    const players = await fetchAllPlayers()
    const playerLookup = buildPlayerLookupMaps(players)

    // Step 1: Scrape schedule to get all game IDs for the season
    await mustSupabase(
        'update BBRef historical schedule phase',
        supabase.from('sync_jobs').update({
            metadata: { season: seasonEndYear, phase: 'schedule' },
        }).eq('id', jobId),
    )

    const games = await fetchBBRefSchedule(seasonEndYear)
    console.log(`[bbrefHistory] Season ${seasonEndYear}: ${games.length} games in schedule`)

    if (!games.length) {
        throw new Error(`BBRef schedule for ${seasonEndYear} returned zero games`)
    }

    // Calculate week numbers from season start
    const dateCounts = new Map<string, number>()
    for (const g of games) dateCounts.set(g.gameDate, (dateCounts.get(g.gameDate) ?? 0) + 1)
    const bulkStart = [...dateCounts.entries()]
        .filter(([, c]) => c >= 5).map(([d]) => d).sort()[0]
    const seasonStart = bulkStart ?? games.map((g) => g.gameDate).sort()[0]
    const startMs = new Date(seasonStart).getTime()

    const getWeekNumber = (date: string) => {
        const daysDiff = Math.floor((new Date(date).getTime() - startMs) / 86_400_000)
        return Math.max(1, Math.floor(daysDiff / 7) + 1)
    }

    // Upsert all game records first (so we can reference their IDs when inserting stats)
    const weekMap: Record<number, { start: string; end: string }> = {}
    const gameRecords = games.map((g) => {
        const wk = getWeekNumber(g.gameDate)
        if (!weekMap[wk]) weekMap[wk] = { start: g.gameDate, end: g.gameDate }
        else {
            if (g.gameDate < weekMap[wk].start) weekMap[wk].start = g.gameDate
            if (g.gameDate > weekMap[wk].end) weekMap[wk].end = g.gameDate
        }
        return {
            nba_game_id: g.bbrefId,
            bbref_home_team: g.homeTeamBBRef,
            bbref_away_team: g.awayTeamBBRef,
            season_year: seasonEndYear,
            game_date: g.gameDate,
            home_team: g.homeTeam,
            away_team: g.awayTeam,
            status: 'Final',
            week_number: wk,
            updated_at: new Date().toISOString(),
        }
    })

    // Insert game records in chunks
    for (let i = 0; i < gameRecords.length; i += 500) {
        const { error } = await supabase
            .from('nba_games')
            .upsert(gameRecords.slice(i, i + 500), { onConflict: 'nba_game_id' })
        if (error) throw error
    }

    // Upsert season_weeks
    const weeks = Object.entries(weekMap).map(([wk, range]) => ({
        season_year: seasonEndYear,
        week_number: parseInt(wk),
        week_start: range.start,
        week_end: range.end,
    }))
    {
        const { error } = await supabase.from('season_weeks').upsert(weeks, { onConflict: 'season_year,week_number' })
        if (error) throw error
    }

    // Update job with total game count
    await mustSupabase(
        'update BBRef historical total items',
        supabase.from('sync_jobs').update({
            total_items: games.length,
            metadata: { season: seasonEndYear, phase: 'boxscores' },
        }).eq('id', jobId),
    )

    // Load DB game ID map (paginated — seasons can exceed 1000 games)
    const dbGameMap = new Map<string, any>()
    {
        let pg = 0
        while (true) {
            const batch = await mustSupabase(
                'load BBRef historical game map',
                supabase
                    .from('nba_games')
                    .select('id, nba_game_id, week_number, bbref_home_team, bbref_away_team')
                    .eq('season_year', seasonEndYear)
                    .range(pg * 1000, pg * 1000 + 999),
            )
            if (!batch?.length) break
            for (const g of batch as any[]) dbGameMap.set(g.nba_game_id, g)
            if (batch.length < 1000) break
            pg++
        }
    }

    let completed = 0
    let failed = 0
    const errorLog: Array<{ gameId: string; error: string }> = []

    for (const game of games) {
        const dbGame = dbGameMap.get(game.bbrefId)
        if (!dbGame) {
            failed++
            errorLog.push({ gameId: game.bbrefId, error: 'Game row missing after schedule upsert' })
            continue
        }

        try {
            const boxScore = await fetchBBRefBoxScore(game.bbrefId, game.homeTeamBBRef, game.awayTeamBBRef)
            const allPlayers: Array<{ stat: BBRefPlayerStat; team: string }> = [
                ...boxScore.home.map((s) => ({ stat: s, team: game.homeTeam })),
                ...boxScore.away.map((s) => ({ stat: s, team: game.awayTeam })),
            ]

            const stats: any[] = []
            const unresolvedPlayers: string[] = []
            for (const { stat } of allPlayers) {
                const playerId = lookupPlayerByName(playerLookup, stat.playerName)

                if (!playerId) {
                    unresolvedPlayers.push(stat.playerName)
                    continue
                }

                const minutesPlayed = stat.minutesDecimal
                const dnp = stat.dnp || minutesPlayed == null

                const pts = stat.pts
                const reb = stat.reb
                const ast = stat.ast
                const stl = stat.stl
                const blk = stat.blk
                const statCats = [pts >= 10, reb >= 10, ast >= 10, stl >= 10, blk >= 10].filter(Boolean).length

                stats.push({
                    player_id: playerId,
                    game_id: dbGame.id,
                    season_year: seasonEndYear,
                    week_number: dbGame.week_number,
                    minutes_played: minutesPlayed,
                    points: pts,
                    rebounds: reb,
                    offensive_rebounds: stat.orb,
                    defensive_rebounds: stat.drb,
                    assists: ast,
                    steals: stl,
                    blocks: blk,
                    turnovers: stat.tov,
                    personal_fouls: stat.pf,
                    field_goals_made: stat.fgm,
                    field_goals_attempted: stat.fga,
                    three_pointers_made: stat.tpm,
                    three_pointers_attempted: stat.tpa,
                    free_throws_made: stat.ftm,
                    free_throws_attempted: stat.fta,
                    plus_minus: stat.plusMinus,
                    double_double: statCats >= 2,
                    triple_double: statCats >= 3,
                    did_not_play: dnp,
                    updated_at: new Date().toISOString(),
                })
            }

            if (unresolvedPlayers.length) {
                throw new Error(`Unresolved or ambiguous BBRef players: ${unresolvedPlayers.join(', ')}`)
            }

            if (!stats.length) throw new Error('No player stats parsed from BBRef box score.')

            await mustSupabase(
                'upsert BBRef historical stats',
                supabase
                    .from('player_game_stats')
                    .upsert(stats, { onConflict: 'player_id,game_id' }),
            )

            completed++
        } catch (e: any) {
            failed++
            errorLog.push({ gameId: game.bbrefId, error: e.message })
            console.warn(`[bbrefHistory] ${game.bbrefId}: ${e.message}`)
        }

        // Update progress every 20 games
        if (completed % 20 === 0) {
            await mustSupabase(
                'update BBRef historical progress',
                supabase.from('sync_jobs').update({
                    completed_items: completed,
                    failed_items: failed,
                    error_log: errorLog.slice(-100),
                }).eq('id', jobId),
            )
        }

        await sleep(3000)
    }

    await mustSupabase(
        'update BBRef historical final progress',
        supabase.from('sync_jobs').update({
            completed_items: completed,
            failed_items: failed,
            error_log: errorLog.slice(-100),
        }).eq('id', jobId),
    )

    console.log(`[bbrefHistory] Season ${seasonEndYear}: ${completed}/${games.length} games synced, ${failed} errors`)
    return { completed, failed }
}

async function mustSupabase<T>(
    label: string,
    request: PromiseLike<{ data: T; error: any }>,
): Promise<T> {
    const { data, error } = await request
    if (error) throw new Error(`${label}: ${error.message ?? String(error)}`)
    return data
}
