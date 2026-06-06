import { supabase, fetchAllPlayers } from '../lib/supabase'
import { fetchBoxScore } from '../lib/nba'
import { buildStatRow } from './stats'
import { CONFIG } from '../config'
import { syncCDNHistoricalSeason, CDN_HISTORICAL_SEASONS } from './historicalCDN'
import { syncBBRefSeason, BBREF_SEASONS } from './historicalBBRef'
import { sleep } from '../lib/utils/sleep'
import { todayET } from '../lib/utils/date'
import { buildPlayerLookupMaps, lookupPlayerByName } from '../lib/utils/nameMatch'
import { persistNbaIdUpdates } from '../lib/playerIdentity'

export interface BackfillOptions {
    fromDate?: string   // YYYY-MM-DD
    toDate?: string     // YYYY-MM-DD
    forceResync?: boolean
}

export interface SyncJob {
    id: string
    job_type: string
    status: string
    total_items: number | null
    completed_items: number
    failed_items: number
    error_log: Array<{ gameId: string; error: string }>
    started_at: string | null
    completed_at: string | null
    created_at: string
    metadata: Record<string, any>
}

// Start a background backfill — returns immediately with jobId
export async function startBackfill(seasonYear: number, options: BackfillOptions = {}): Promise<string> {
    const { data: job, error } = await supabase
        .from('sync_jobs')
        .insert({
            job_type: 'backfill_stats',
            status: 'running',
            started_at: new Date().toISOString(),
            metadata: { seasonYear, ...options },
        })
        .select('id')
        .single()

    if (error || !job) throw error ?? new Error('Failed to create sync_jobs row')

    // Run async — caller gets jobId immediately
    runBackfill(job.id, seasonYear, options).catch(async (err) => {
        console.error('[backfill] Fatal error:', err.message)
        await supabase
            .from('sync_jobs')
            .update({ status: 'failed', completed_at: new Date().toISOString() })
            .eq('id', job.id)
    })

    return job.id
}

export async function getBackfillProgress(jobId: string): Promise<SyncJob | null> {
    const { data } = await supabase
        .from('sync_jobs')
        .select('*')
        .eq('id', jobId)
        .single()
    return data as SyncJob | null
}

async function runBackfill(jobId: string, seasonYear: number, options: BackfillOptions) {
    const today = todayET()

    // Build query for games we should fetch
    let query = supabase
        .from('nba_games')
        .select('id, nba_game_id, game_date, week_number, season_year, status')
        .eq('season_year', seasonYear)
        .not('nba_game_id', 'is', null)
        .lt('game_date', today) // Don't touch today — that's syncStatsByDate's job
        .order('game_date', { ascending: true })

    if (options.fromDate) query = query.gte('game_date', options.fromDate)
    if (options.toDate) query = query.lte('game_date', options.toDate)

    const { data: allGames, error: gErr } = await query
    if (gErr) throw gErr
    if (!allGames?.length) {
        await supabase
            .from('sync_jobs')
            .update({ status: 'completed', total_items: 0, completed_at: new Date().toISOString() })
            .eq('id', jobId)
        return
    }

    // Reprocess requested games even if some stats already exist. A single
    // player_game_stats row is not proof that the whole box score was synced;
    // rerunning repairs partial games instead of making them permanently
    // invisible to backfill.
    const gamesToFetch = allGames

    await supabase
        .from('sync_jobs')
        .update({ total_items: gamesToFetch.length })
        .eq('id', jobId)

    console.log(`[backfill] ${gamesToFetch.length} games to sync for season ${seasonYear}`)

    // Load player lookup maps once
    const players = await fetchAllPlayers()
    const playerLookup = buildPlayerLookupMaps(players)
    const byNbaId = playerLookup.byNbaId

    const nbaIdUpdates: { id: string; nba_id: string }[] = []
    const errorLog: Array<{ gameId: string; error: string }> = []
    let completed = 0

    // Group by date to process chronologically and throttle
    const byDate = new Map<string, typeof gamesToFetch>()
    for (const g of gamesToFetch) {
        const existing = byDate.get(g.game_date) ?? []
        existing.push(g)
        byDate.set(g.game_date, existing)
    }

    for (const [date, games] of byDate) {
        console.log(`[backfill] Processing ${games.length} games for ${date}`)

        // Process in chunks of BACKFILL_CONCURRENCY
        for (let i = 0; i < games.length; i += CONFIG.BACKFILL_CONCURRENCY) {
            const chunk = games.slice(i, i + CONFIG.BACKFILL_CONCURRENCY)
            const chunkResults = await Promise.all(
                chunk.map(async (game) => {
                    try {
                        const boxScore = await fetchBoxScore(game.nba_game_id!)
                        const cdnStatus = boxScore.gameStatus

                        // Skip if game isn't actually finished on CDN
                        if (cdnStatus !== 3) throw new Error(`CDN game is not final (status ${cdnStatus})`)

                        const allPlayers = [
                            ...(boxScore.homeTeam?.players ?? []),
                            ...(boxScore.awayTeam?.players ?? []),
                        ]

                        const stats: any[] = []
                        const unresolvedPlayers: string[] = []
                        for (const p of allPlayers) {
                            if (!p.statistics) continue
                            const personId = String(p.personId)
                            let playerId = byNbaId.get(personId)

                            if (!playerId) {
                                playerId = lookupPlayerByName(playerLookup, p.name ?? '') ?? undefined
                                if (playerId && !byNbaId.has(personId)) {
                                    nbaIdUpdates.push({ id: playerId, nba_id: personId })
                                    byNbaId.set(personId, playerId)
                                }
                            }

                            if (!playerId) {
                                unresolvedPlayers.push(`${p.name ?? 'Unknown'} (${personId})`)
                                continue
                            }

                            stats.push(buildStatRow(p, playerId, game.id, game.season_year, game.week_number))
                        }

                        if (unresolvedPlayers.length) {
                            throw new Error(`Unresolved or ambiguous players: ${unresolvedPlayers.join(', ')}`)
                        }

                        if (!stats.length) throw new Error('No player stats parsed from final box score.')

                        const { error } = await supabase
                            .from('player_game_stats')
                            .upsert(stats, { onConflict: 'player_id,game_id' })
                        if (error) throw error

                        if (game.status !== 'Final') {
                            const { error: statusError } = await supabase
                                .from('nba_games')
                                .update({ status: 'Final' })
                                .eq('id', game.id)
                            if (statusError) throw statusError
                        }
                        return true
                    } catch (e: any) {
                        // 404 = game not on CDN; log and continue
                        const msg = e.response?.status === 404
                            ? `404 Not Found (game may be unavailable on CDN)`
                            : e.message
                        errorLog.push({ gameId: game.nba_game_id!, error: msg })
                        console.warn(`[backfill] ${game.nba_game_id}: ${msg}`)
                        return false
                    }
                }),
            )

            completed += chunkResults.filter(Boolean).length

            // Update progress every chunk
            await supabase
                .from('sync_jobs')
                .update({
                    completed_items: completed,
                    failed_items: errorLog.length,
                    error_log: errorLog.slice(-100), // keep last 100 errors
                })
                .eq('id', jobId)

            // Throttle between chunks
            if (i + CONFIG.BACKFILL_CONCURRENCY < games.length) {
                await sleep(CONFIG.BACKFILL_DELAY_MS)
            }
        }

        // Throttle between dates
        await sleep(CONFIG.BACKFILL_DELAY_MS)
    }

    if (nbaIdUpdates.length > 0) {
        const persistedNbaIds = await persistNbaIdUpdates(nbaIdUpdates)
        console.log(`[backfill] Mapped ${persistedNbaIds.updated} new NBA person IDs; merged ${persistedNbaIds.merged} duplicate rows before update.`)
    }

    await supabase
        .from('sync_jobs')
        .update({
            status: errorLog.length > 0 ? 'completed_with_errors' : 'completed',
            completed_items: completed,
            failed_items: errorLog.length,
            error_log: errorLog.slice(-100),
            completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)

    console.log(`[backfill] Done. ${completed} games processed, ${errorLog.length} errors.`)
}


export interface FullHistoryOptions {
    cdnSeasons?: number[]   // override which CDN start-year 2-digit values to run
    bbrefSeasons?: number[] // override which BBRef ending years to run
}

/**
 * Kick off a complete historical backfill from 2003-04 to 2024-25.
 *
 * Creates one sync_job per season and runs them sequentially (CDN seasons first
 * newest→oldest, then BBRef seasons newest→oldest). Returns a summary job ID
 * that tracks overall progress across all seasons.
 */
export async function startFullHistoricalBackfill(
    opts: FullHistoryOptions = {},
): Promise<string> {
    const cdnSeasons = opts.cdnSeasons ?? [...CDN_HISTORICAL_SEASONS]     // [24,23,22,21,20,19]
    const bbrefSeasons = opts.bbrefSeasons ?? [...BBREF_SEASONS].reverse() // 2019..2004

    const totalSeasons = cdnSeasons.length + bbrefSeasons.length

    const { data: masterJob, error } = await supabase
        .from('sync_jobs')
        .insert({
            job_type: 'full_historical_backfill',
            status: 'running',
            total_items: totalSeasons,
            started_at: new Date().toISOString(),
            metadata: { cdnSeasons, bbrefSeasons },
        })
        .select('id')
        .single()

    if (error || !masterJob) throw error ?? new Error('Failed to create master sync_job')

    runFullHistoricalBackfill(masterJob.id, cdnSeasons, bbrefSeasons).catch(async (err) => {
        console.error('[fullHistory] Fatal:', err.message)
        await supabase
            .from('sync_jobs')
            .update({ status: 'failed', completed_at: new Date().toISOString() })
            .eq('id', masterJob.id)
    })

    return masterJob.id
}

async function runFullHistoricalBackfill(
    masterJobId: string,
    cdnSeasons: number[],
    bbrefSeasons: number[],
) {
    let seasonsCompleted = 0
    let seasonsWithErrors = 0

    // CDN seasons (2019-20 through 2024-25)
    for (const startYY of cdnSeasons) {
        const seasonYear = 2000 + startYY + 1
        console.log(`[fullHistory] CDN season ${seasonYear}`)

        const { data: job } = await supabase
            .from('sync_jobs')
            .insert({
                job_type: 'backfill_cdn_season',
                status: 'running',
                started_at: new Date().toISOString(),
                metadata: { seasonYear, startYY },
            })
            .select('id')
            .single()

        if (!job) continue

        try {
            const result = await syncCDNHistoricalSeason(startYY, job.id)
            if (result.failed > 0) seasonsWithErrors++
            await supabase.from('sync_jobs').update({
                status: result.failed > 0 ? 'completed_with_errors' : 'completed',
                completed_at: new Date().toISOString(),
            }).eq('id', job.id)
        } catch (e: any) {
            seasonsWithErrors++
            console.error(`[fullHistory] CDN ${seasonYear} failed:`, e.message)
            await supabase.from('sync_jobs').update({ status: 'failed' }).eq('id', job.id)
        }

        seasonsCompleted++
        await supabase.from('sync_jobs').update({ completed_items: seasonsCompleted }).eq('id', masterJobId)
    }

    // BBRef seasons (2018-19 down to 2003-04)
    for (const seasonEndYear of bbrefSeasons) {
        console.log(`[fullHistory] BBRef season ${seasonEndYear}`)

        const { data: job } = await supabase
            .from('sync_jobs')
            .insert({
                job_type: 'backfill_bbref_season',
                status: 'running',
                started_at: new Date().toISOString(),
                metadata: { seasonEndYear },
            })
            .select('id')
            .single()

        if (!job) continue

        try {
            const result = await syncBBRefSeason(seasonEndYear, job.id)
            if (result.failed > 0) seasonsWithErrors++
            await supabase.from('sync_jobs').update({
                status: result.failed > 0 ? 'completed_with_errors' : 'completed',
                completed_at: new Date().toISOString(),
            }).eq('id', job.id)
        } catch (e: any) {
            seasonsWithErrors++
            console.error(`[fullHistory] BBRef ${seasonEndYear} failed:`, e.message)
            await supabase.from('sync_jobs').update({ status: 'failed' }).eq('id', job.id)
        }

        seasonsCompleted++
        await supabase.from('sync_jobs').update({ completed_items: seasonsCompleted }).eq('id', masterJobId)
    }

    await supabase.from('sync_jobs').update({
        status: seasonsWithErrors > 0 ? 'completed_with_errors' : 'completed',
        completed_items: seasonsCompleted,
        failed_items: seasonsWithErrors,
        completed_at: new Date().toISOString(),
    }).eq('id', masterJobId)

    console.log(`[fullHistory] All ${seasonsCompleted} seasons complete.`)
}
