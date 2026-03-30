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
import { fetchBBRefSchedule, fetchBBRefBoxScore, BBRefPlayerStat, sleep } from '../lib/bbref'

// BBRef seasons available: ending years 2004-2019 (2003-04 through 2018-19)
export const BBREF_SEASONS = Array.from({ length: 16 }, (_, i) => 2004 + i) // 2004..2019

export async function syncBBRefSeason(seasonEndYear: number, jobId: string): Promise<void> {
    console.log(`[bbrefHistory] Starting season ${seasonEndYear - 1}-${seasonEndYear}`)

    // Load player lookup maps
    const players = await fetchAllPlayers()
    const byNbaId = new Map<string, string>()
    const byName = new Map<string, string>()
    for (const p of players) {
        if (p.nba_id) byNbaId.set(p.nba_id, p.id)
        byName.set(normalizePlayerName(p.display_name), p.id)
    }

    // Step 1: Scrape schedule to get all game IDs for the season
    await supabase.from('sync_jobs').update({
        metadata: { season: seasonEndYear, phase: 'schedule' },
    }).eq('id', jobId)

    const games = await fetchBBRefSchedule(seasonEndYear)
    console.log(`[bbrefHistory] Season ${seasonEndYear}: ${games.length} games in schedule`)

    if (!games.length) {
        console.warn(`[bbrefHistory] No games found for season ${seasonEndYear}`)
        return
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
        await supabase.from('nba_games').upsert(gameRecords.slice(i, i + 500), { onConflict: 'nba_game_id' })
    }

    // Upsert season_weeks
    const weeks = Object.entries(weekMap).map(([wk, range]) => ({
        season_year: seasonEndYear,
        week_number: parseInt(wk),
        week_start: range.start,
        week_end: range.end,
    }))
    await supabase.from('season_weeks').upsert(weeks, { onConflict: 'season_year,week_number' })

    // Update job with total game count
    await supabase.from('sync_jobs').update({
        total_items: games.length,
        metadata: { season: seasonEndYear, phase: 'boxscores' },
    }).eq('id', jobId)

    // Step 2: Scrape box scores — skip games that already have stats
    const { data: syncedRows } = await supabase
        .from('player_game_stats')
        .select('game_id')
        .eq('season_year', seasonEndYear)
        .limit(1000)
    const syncedGameIds = new Set((syncedRows ?? []).map((r: any) => r.game_id))

    // Load DB game ID map
    const { data: dbGames } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, week_number')
        .eq('season_year', seasonEndYear)
    const dbGameMap = new Map((dbGames ?? []).map((g: any) => [g.nba_game_id, g]))

    let completed = 0
    let failed = 0
    const errorLog: Array<{ gameId: string; error: string }> = []

    for (const game of games) {
        const dbGame = dbGameMap.get(game.bbrefId)
        if (!dbGame) continue
        if (syncedGameIds.has(dbGame.id)) { completed++; continue }

        try {
            const boxScore = await fetchBBRefBoxScore(game.bbrefId, game.homeTeamBBRef, game.awayTeamBBRef)
            const allPlayers: Array<{ stat: BBRefPlayerStat; team: string }> = [
                ...boxScore.home.map((s) => ({ stat: s, team: game.homeTeam })),
                ...boxScore.away.map((s) => ({ stat: s, team: game.awayTeam })),
            ]

            const stats: any[] = []
            for (const { stat } of allPlayers) {
                const nameLower = normalizePlayerName(stat.playerName)
                let playerId = byName.get(nameLower)

                if (!playerId) continue

                const minutesPlayed = stat.minutesDecimal
                const dnp = stat.dnp || !minutesPlayed || minutesPlayed < 0.5

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

            if (stats.length) {
                const { error } = await supabase
                    .from('player_game_stats')
                    .upsert(stats, { onConflict: 'player_id,game_id' })
                if (error) throw error
            }

            completed++
        } catch (e: any) {
            failed++
            errorLog.push({ gameId: game.bbrefId, error: e.message })
            console.warn(`[bbrefHistory] ${game.bbrefId}: ${e.message}`)
        }

        // Update progress every 20 games
        if (completed % 20 === 0) {
            await supabase.from('sync_jobs').update({
                completed_items: completed,
                failed_items: failed,
                error_log: errorLog.slice(-100),
            }).eq('id', jobId)
        }

        await sleep(3000)
    }

    await supabase.from('sync_jobs').update({
        completed_items: completed,
        failed_items: failed,
        error_log: errorLog.slice(-100),
    }).eq('id', jobId)

    console.log(`[bbrefHistory] Season ${seasonEndYear}: ${completed}/${games.length} games synced, ${failed} errors`)
}

// Normalize player name for matching: lowercase, remove suffixes, normalize punctuation
function normalizePlayerName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '')
        .replace(/[.']/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}
