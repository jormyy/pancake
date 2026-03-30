/**
 * Historical CDN backfill — seasons 2019-20 through 2024-25
 *
 * NBA CDN box scores are available for all games in these seasons.
 * Since no schedule file exists for prior seasons, we enumerate game IDs
 * sequentially (regular season 0001-1300, playoffs 0001-0300) and fetch
 * each one, skipping 404s.
 *
 * Game ID format: {type}{YY}0{NNNN}
 *   type: 002 = regular season, 004 = playoffs
 *   YY:   2-digit start year (e.g. 19 for 2019-20, 24 for 2024-25)
 *   NNNN: 4-digit sequential game number
 */
import axios from 'axios'
import { supabase, fetchAllPlayers } from '../lib/supabase'
import { buildStatRow } from './stats'
import { CONFIG } from '../config'

const CDN_BASE = 'https://cdn.nba.com/static/json'
const CDN_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nba.com',
    'Referer': 'https://www.nba.com/',
}

const cdnClient = axios.create({ timeout: 15000, headers: CDN_HEADERS })

// CDN seasons available: start years 19-24 (2019-20 through 2024-25)
export const CDN_HISTORICAL_SEASONS = [24, 23, 22, 21, 20, 19] as const

// Convert 2-digit start year → season_year (ending year)
// e.g. 19 → 2020, 24 → 2025
function toSeasonYear(startYY: number): number {
    return 2000 + startYY + 1
}

export async function syncCDNHistoricalSeason(
    startYY: number,
    jobId: string,
): Promise<void> {
    const seasonYear = toSeasonYear(startYY)
    const yy = String(startYY).padStart(2, '0')
    console.log(`[cdnHistory] Starting season ${seasonYear - 1}-${seasonYear} (YY=${yy})`)

    // Load player lookup maps
    const players = await fetchAllPlayers()
    const byNbaId = new Map<string, string>()
    const byName = new Map<string, string>()
    for (const p of players) {
        if (p.nba_id) byNbaId.set(p.nba_id, p.id)
        byName.set(p.display_name.toLowerCase(), p.id)
    }

    // Game ranges to probe
    const ranges = [
        { prefix: `002${yy}0`, max: 1300 },  // regular season
        { prefix: `004${yy}0`, max: 300 },   // playoffs
    ]

    // First pass: count how many games exist (for total_items estimate)
    // We skip this and just update progress as we go

    const nbaIdUpdates: { id: string; nba_id: string }[] = []
    let completed = 0
    let failed = 0
    const errorLog: Array<{ gameId: string; error: string }> = []

    // Track game dates to calculate week numbers per season
    const gameDateSet = new Map<string, { gameId: string; date: string; home: string; away: string }>()

    for (const { prefix, max } of ranges) {
        let consecutiveMisses = 0

        for (let n = 1; n <= max; n++) {
            const gameId = `${prefix}${String(n).padStart(4, '0')}`

            try {
                const { data } = await cdnClient.get(
                    `${CDN_BASE}/liveData/boxscore/boxscore_${gameId}.json`,
                )
                const game = data.game

                if (game.gameStatus !== 3) {
                    // Not final — skip (shouldn't happen for historical games)
                    consecutiveMisses = 0
                    continue
                }

                consecutiveMisses = 0

                // Parse game date from gameEt ISO string
                const gameDate = game.gameEt
                    ? game.gameEt.split('T')[0]
                    : null
                if (!gameDate) continue

                const homeTricode = game.homeTeam?.teamTricode ?? ''
                const awayTricode = game.awayTeam?.teamTricode ?? ''
                if (!homeTricode || !awayTricode) continue

                gameDateSet.set(gameId, { gameId, date: gameDate, home: homeTricode, away: awayTricode })

                // Upsert game record (week_number calculated after full pass)
                await supabase.from('nba_games').upsert({
                    nba_game_id: gameId,
                    season_year: seasonYear,
                    game_date: gameDate,
                    home_team: homeTricode,
                    away_team: awayTricode,
                    status: 'Final',
                    week_number: 0, // placeholder, recalculated below
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'nba_game_id' })

                // Build and upsert stats
                const allPlayers = [
                    ...(game.homeTeam?.players ?? []),
                    ...(game.awayTeam?.players ?? []),
                ]

                // Look up DB game id
                const { data: dbGame } = await supabase
                    .from('nba_games')
                    .select('id, week_number')
                    .eq('nba_game_id', gameId)
                    .single()
                if (!dbGame) continue

                const stats: any[] = []
                for (const p of allPlayers) {
                    if (!p.statistics) continue
                    const personId = String(p.personId)
                    let playerId = byNbaId.get(personId)
                    if (!playerId) {
                        const nameLower = (p.name ?? '').toLowerCase()
                        playerId = byName.get(nameLower)
                        if (playerId && !byNbaId.has(personId)) {
                            nbaIdUpdates.push({ id: playerId, nba_id: personId })
                            byNbaId.set(personId, playerId)
                        }
                    }
                    if (!playerId) continue
                    stats.push(buildStatRow(p, playerId, dbGame.id, seasonYear, dbGame.week_number))
                }

                if (stats.length) {
                    const { error } = await supabase
                        .from('player_game_stats')
                        .upsert(stats, { onConflict: 'player_id,game_id' })
                    if (error) throw error
                }

                completed++
            } catch (e: any) {
                const status = e.response?.status
                if (status === 404 || status === 403) {
                    consecutiveMisses++
                    // After 20 consecutive misses past first 10 games, assume no more games
                    if (consecutiveMisses > 20 && n > 10) break
                } else {
                    failed++
                    errorLog.push({ gameId, error: e.message })
                    console.warn(`[cdnHistory] ${gameId}: ${e.message}`)
                }
            }

            // Update progress every 10 games
            if (n % 10 === 0) {
                await supabase.from('sync_jobs').update({
                    completed_items: completed,
                    failed_items: failed,
                    error_log: errorLog.slice(-100),
                    metadata: { season: seasonYear, phase: 'fetching', gamesFound: gameDateSet.size },
                }).eq('id', jobId)
            }

            await sleep(CONFIG.BACKFILL_DELAY_MS)
        }
    }

    // Recalculate week numbers for this season
    await recalcWeekNumbers(gameDateSet, seasonYear)

    // Persist nba_id mappings
    for (const u of nbaIdUpdates) {
        await supabase.from('players').update({ nba_id: u.nba_id }).eq('id', u.id)
    }

    console.log(`[cdnHistory] Season ${seasonYear}: ${gameDateSet.size} games, ${completed} stat sets, ${failed} errors`)
}

async function recalcWeekNumbers(
    games: Map<string, { gameId: string; date: string; home: string; away: string }>,
    seasonYear: number,
) {
    if (!games.size) return

    // Find season start: first date with >= 5 games (skips international openers)
    const dateCounts = new Map<string, number>()
    for (const { date } of games.values()) dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1)

    const bulkStart = [...dateCounts.entries()]
        .filter(([, c]) => c >= 5)
        .map(([d]) => d)
        .sort()[0]
    const seasonStart = bulkStart ?? [...dateCounts.keys()].sort()[0]
    const startMs = new Date(seasonStart).getTime()

    // Assign week numbers and update nba_games
    const weekMap: Record<number, { start: string; end: string }> = {}
    const updates: { nba_game_id: string; week_number: number }[] = []

    for (const { gameId, date } of games.values()) {
        const daysDiff = Math.floor((new Date(date).getTime() - startMs) / 86_400_000)
        const weekNumber = Math.max(1, Math.floor(daysDiff / 7) + 1)
        updates.push({ nba_game_id: gameId, week_number: weekNumber })

        if (!weekMap[weekNumber]) weekMap[weekNumber] = { start: date, end: date }
        else {
            if (date < weekMap[weekNumber].start) weekMap[weekNumber].start = date
            if (date > weekMap[weekNumber].end) weekMap[weekNumber].end = date
        }
    }

    // Bulk update week numbers
    for (const { nba_game_id, week_number } of updates) {
        await supabase.from('nba_games').update({ week_number }).eq('nba_game_id', nba_game_id)
    }

    // Upsert season_weeks
    const weeks = Object.entries(weekMap).map(([wk, range]) => ({
        season_year: seasonYear,
        week_number: parseInt(wk),
        week_start: range.start,
        week_end: range.end,
    }))
    if (weeks.length) {
        await supabase.from('season_weeks').upsert(weeks, { onConflict: 'season_year,week_number' })
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
