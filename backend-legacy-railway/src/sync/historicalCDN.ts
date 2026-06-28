/**
 * Historical CDN backfill — seasons 2019-20 through 2024-25
 *
 * NBA CDN box scores are available for all games in these seasons.
 * Since no schedule file exists for prior seasons, we enumerate game IDs
 * sequentially (regular season 0001-1300) and fetch
 * each one, skipping 404s.
 *
 * Game ID format: {type}{YY}0{NNNN}
 *   type: 002 = regular season
 *   YY:   2-digit start year (e.g. 19 for 2019-20, 24 for 2024-25)
 *   NNNN: 4-digit sequential game number
 */
import axios from 'axios'
import { supabase, fetchAllPlayers } from '../lib/supabase'
import { buildStatRow } from './stats'
import { CONFIG } from '../config'
import { sleep } from '../lib/utils/sleep'
import { buildPlayerLookupMaps, lookupPlayerByName } from '../lib/utils/nameMatch'
import { persistNbaIdUpdates } from '../lib/playerIdentity'

const CDN_BASE = process.env.NBA_CDN_BASE_URL ?? 'https://cdn.nba.com/static/json'
const CDN_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nba.com',
    'Referer': 'https://www.nba.com/',
}

const cdnClient = axios.create({ timeout: 15000, headers: CDN_HEADERS })
type HistoricalSeasonResult = { completed: number; failed: number }

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
): Promise<HistoricalSeasonResult> {
    const seasonYear = toSeasonYear(startYY)
    const yy = String(startYY).padStart(2, '0')
    console.log(`[cdnHistory] Starting season ${seasonYear - 1}-${seasonYear} (YY=${yy})`)

    const players = await fetchAllPlayers()
    const playerLookup = buildPlayerLookupMaps(players)
    const byNbaId = playerLookup.byNbaId

    const ranges = buildCandidateGameIdRanges(yy)
    const terminalGameIds = await loadAttemptedGameIds(jobId)

    let completed = 0
    let failed = 0
    const errorLog: Array<{ gameId: string; error: string }> = []

    // Track game dates to calculate week numbers per season
    const gameDateSet = new Map<string, { gameId: string; date: string; home: string; away: string }>()

    for (const gameIds of ranges) {
        let consecutiveMisses = 0

        for (let n = 0; n < gameIds.length; n++) {
            const gameId = gameIds[n]
            if (terminalGameIds.has(gameId)) continue

            try {
                const { data } = await cdnClient.get(
                    `${CDN_BASE}/liveData/boxscore/boxscore_${gameId}.json`,
                )
                const game = data.game

                if (game.gameStatus !== 3) {
                    throw new Error(`CDN game ${gameId} is not final`)
                }

                consecutiveMisses = 0

                // Parse game date from gameEt ISO string
                const gameDate = game.gameEt
                    ? game.gameEt.split('T')[0]
                    : null
                if (!gameDate) throw new Error(`CDN game ${gameId} is missing game date`)

                const homeTricode = game.homeTeam?.teamTricode ?? ''
                const awayTricode = game.awayTeam?.teamTricode ?? ''
                if (!homeTricode || !awayTricode) throw new Error(`CDN game ${gameId} is missing teams`)

                gameDateSet.set(gameId, { gameId, date: gameDate, home: homeTricode, away: awayTricode })

                // Upsert game record (week_number calculated after full pass)
                await mustSupabase(
                    'upsert CDN historical game',
                    supabase.from('nba_games').upsert({
                        nba_game_id: gameId,
                        season_year: seasonYear,
                        game_date: gameDate,
                        home_team: homeTricode,
                        away_team: awayTricode,
                        status: 'Final',
                        week_number: 0, // placeholder, recalculated below
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'nba_game_id' }),
                )

                // Build and upsert stats
                const allPlayers = [
                    ...(game.homeTeam?.players ?? []),
                    ...(game.awayTeam?.players ?? []),
                ]

                // Look up DB game id
                const dbGame = await mustSupabase(
                    'load CDN historical game row',
                    supabase
                        .from('nba_games')
                        .select('id, week_number')
                        .eq('nba_game_id', gameId)
                        .single(),
                )
                if (!dbGame) throw new Error(`CDN game ${gameId} missing after upsert`)

                const stats: any[] = []
                const unresolvedPlayers: string[] = []
                const gameNbaIdUpdates: { id: string; nba_id: string }[] = []
                for (const p of allPlayers) {
                    if (!p.statistics) continue
                    const personId = String(p.personId)
                    let playerId = byNbaId.get(personId)
                    if (!playerId) {
                        playerId = lookupPlayerByName(playerLookup, p.name ?? '') ?? undefined
                        if (playerId && !byNbaId.has(personId)) {
                            gameNbaIdUpdates.push({ id: playerId, nba_id: personId })
                            byNbaId.set(personId, playerId)
                        }
                    }
                    if (!playerId) {
                        unresolvedPlayers.push(`${p.name ?? 'Unknown'} (${personId})`)
                        continue
                    }
                    stats.push(buildStatRow(p, playerId, dbGame.id, seasonYear, dbGame.week_number))
                }

                if (unresolvedPlayers.length) {
                    throw new Error(`Unresolved or ambiguous players: ${unresolvedPlayers.join(', ')}`)
                }

                if (!stats.length) throw new Error(`No player stats parsed from final CDN game ${gameId}`)

                await mustSupabase(
                    'upsert CDN historical stats',
                    supabase
                        .from('player_game_stats')
                        .upsert(stats, { onConflict: 'player_id,game_id' }),
                )

                await persistNbaIdUpdates(gameNbaIdUpdates)
                await recordAttempt(jobId, seasonYear, gameId, 'completed', null, dbGame.id)
                completed++
            } catch (e: any) {
                const status = e.response?.status
                if (status === 404 || status === 403) {
                    await recordAttempt(jobId, seasonYear, gameId, 'missing')
                    consecutiveMisses++
                    // After 20 consecutive misses past first 10 games, assume no more games
                    if (consecutiveMisses > 20 && n > 10) break
                } else {
                    await recordAttempt(jobId, seasonYear, gameId, 'failed', e.message)
                    failed++
                    errorLog.push({ gameId, error: e.message })
                    console.warn(`[cdnHistory] ${gameId}: ${e.message}`)
                }
            }

            // Update progress every 10 games
            if (n % 10 === 0) {
                await mustSupabase(
                    'update CDN historical progress',
                    supabase.from('sync_jobs').update({
                        completed_items: completed,
                        failed_items: failed,
                        error_log: errorLog.slice(-100),
                        metadata: { season: seasonYear, phase: 'fetching', gamesFound: gameDateSet.size },
                    }).eq('id', jobId),
                )
            }

            await sleep(CONFIG.BACKFILL_DELAY_MS)
        }
    }

    // Recalculate week numbers for every persisted game in the season. This
    // keeps same-job resumes correct even when terminal ledger rows skipped
    // games that were already fetched in an earlier invocation.
    await recalcWeekNumbers(seasonYear)

    const ledgerProgress = await loadAttemptProgress(jobId)

    await mustSupabase(
        'update CDN historical final progress',
        supabase.from('sync_jobs').update({
            completed_items: ledgerProgress.completed,
            failed_items: ledgerProgress.failed,
            error_log: errorLog.slice(-100),
            metadata: { season: seasonYear, phase: 'done', gamesFound: gameDateSet.size },
        }).eq('id', jobId),
    )

    console.log(`[cdnHistory] Season ${seasonYear}: ${gameDateSet.size} games, ${ledgerProgress.completed} stat sets, ${ledgerProgress.failed} errors`)
    return { completed: ledgerProgress.completed, failed: ledgerProgress.failed }
}

async function recalcWeekNumbers(seasonYear: number) {
    const games = await loadPersistedSeasonGames(seasonYear)
    if (!games.length) return

    // Find season start: first date with >= 5 games (skips international openers)
    const dateCounts = new Map<string, number>()
    for (const { date } of games) dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1)

    const bulkStart = [...dateCounts.entries()]
        .filter(([, c]) => c >= 5)
        .map(([d]) => d)
        .sort()[0]
    const seasonStart = bulkStart ?? games.map((game) => game.date).sort()[0]
    const startMs = new Date(seasonStart).getTime()

    // Assign week numbers and update nba_games
    const weekMap: Record<number, { start: string; end: string }> = {}
    const updates: { nba_game_id: string; week_number: number }[] = []

    for (const { gameId, date } of games) {
        const daysDiff = Math.floor((new Date(date).getTime() - startMs) / 86_400_000)
        const weekNumber = Math.max(1, Math.floor(daysDiff / 7) + 1)
        updates.push({ nba_game_id: gameId, week_number: weekNumber })

        if (!weekMap[weekNumber]) weekMap[weekNumber] = { start: date, end: date }
        else {
            if (date < weekMap[weekNumber].start) weekMap[weekNumber].start = date
            if (date > weekMap[weekNumber].end) weekMap[weekNumber].end = date
        }
    }

    // Bulk update week numbers — group by week_number so each distinct value
    // collapses into one .update().in() call (typically ~25 weeks per season vs ~1300 games).
    const byWeek = new Map<number, string[]>()
    for (const { nba_game_id, week_number } of updates) {
        const arr = byWeek.get(week_number)
        if (arr) arr.push(nba_game_id)
        else byWeek.set(week_number, [nba_game_id])
    }
    for (const [week_number, gameIds] of byWeek) {
        for (let i = 0; i < gameIds.length; i += 500) {
            await mustSupabase(
                'update CDN historical game week numbers',
                supabase
                    .from('nba_games')
                    .update({ week_number })
                    .in('nba_game_id', gameIds.slice(i, i + 500)),
            )

            const rows = await mustSupabase(
                'load CDN historical game ids for stat week update',
                supabase
                    .from('nba_games')
                    .select('id')
                    .in('nba_game_id', gameIds.slice(i, i + 500)),
            )

            const dbGameIds = (rows ?? []).map((row) => row.id)
            if (dbGameIds.length) {
                await mustSupabase(
                    'update CDN historical stat week numbers',
                    supabase
                        .from('player_game_stats')
                        .update({ week_number })
                        .in('game_id', dbGameIds),
                )
            }
        }
    }

    // Upsert season_weeks
    const weeks = Object.entries(weekMap).map(([wk, range]) => ({
        season_year: seasonYear,
        week_number: parseInt(wk),
        week_start: range.start,
        week_end: range.end,
    }))
    if (weeks.length) {
        await mustSupabase(
            'upsert CDN historical season weeks',
            supabase.from('season_weeks').upsert(weeks, { onConflict: 'season_year,week_number' }),
        )
    }
}

async function mustSupabase<T>(
    label: string,
    request: PromiseLike<{ data: T; error: any }>,
): Promise<T> {
    const { data, error } = await request
    if (error) throw new Error(`${label}: ${error.message ?? String(error)}`)
    return data
}

async function loadPersistedSeasonGames(seasonYear: number): Promise<Array<{ gameId: string; date: string }>> {
    const games: Array<{ gameId: string; date: string }> = []
    let page = 0

    while (true) {
        const { data, error } = await supabase
            .from('nba_games')
            .select('nba_game_id, game_date')
            .eq('season_year', seasonYear)
            .eq('status', 'Final')
            .like('nba_game_id', '002%')
            .order('game_date', { ascending: true })
            .range(page * 1000, page * 1000 + 999)
        if (error) throw error
        if (!data?.length) break
        for (const row of data) {
            if (row.nba_game_id && row.game_date) games.push({ gameId: row.nba_game_id, date: row.game_date })
        }
        if (data.length < 1000) break
        page++
    }

    return games
}

function buildCandidateGameIdRanges(yy: string): string[][] {
    const regularSeason = Array.from(
        { length: 1300 },
        (_, index) => `002${yy}0${String(index + 1).padStart(4, '0')}`,
    )
    return [regularSeason]
}

async function loadAttemptedGameIds(jobId: string): Promise<Set<string>> {
    const attempted = new Set<string>()
    let page = 0
    while (true) {
        const { data, error } = await supabase
            .from('backfill_game_attempts')
            .select('game_key')
            .eq('job_id', jobId)
            .eq('source', 'backend-cdn-history')
            .in('status', ['completed', 'failed', 'missing'])
            .range(page * 1000, page * 1000 + 999)
        if (error) throw error
        if (!data?.length) break
        for (const row of data) attempted.add(row.game_key)
        if (data.length < 1000) break
        page++
    }
    return attempted
}

async function recordAttempt(
    jobId: string,
    seasonYear: number,
    gameId: string,
    status: 'completed' | 'failed' | 'missing',
    error: string | null = null,
    gameDbId: string | null = null,
): Promise<void> {
    const { error: upsertError } = await supabase
        .from('backfill_game_attempts')
        .upsert({
            job_id: jobId,
            source: 'backend-cdn-history',
            season_year: seasonYear,
            game_key: gameId,
            game_db_id: gameDbId,
            status,
            attempts: 1,
            last_error: error,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'job_id,source,game_key' })
    if (upsertError) throw upsertError
}

async function loadAttemptProgress(jobId: string): Promise<{ completed: number; failed: number; missing: number }> {
    const progress = { completed: 0, failed: 0, missing: 0 }
    let page = 0
    while (true) {
        const { data, error } = await supabase
            .from('backfill_game_attempts')
            .select('status')
            .eq('job_id', jobId)
            .eq('source', 'backend-cdn-history')
            .range(page * 1000, page * 1000 + 999)
        if (error) throw error
        if (!data?.length) break
        for (const row of data) {
            if (row.status === 'completed') progress.completed++
            else if (row.status === 'failed') progress.failed++
            else if (row.status === 'missing') progress.missing++
        }
        if (data.length < 1000) break
        page++
    }
    return progress
}
