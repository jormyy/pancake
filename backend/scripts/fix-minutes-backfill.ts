/**
 * One-off script: re-sync minutes_played for all NBA CDN seasons (2020–2026).
 *
 * Root cause: parseNBAMinutes previously dropped the seconds component of
 * ISO durations like "PT35M12.00S", storing 35 instead of 35.2.
 * BBRef seasons (≤2019) used minutesDecimal directly — those are unaffected.
 *
 * Run: npx tsx scripts/fix-minutes-backfill.ts
 */

import 'dotenv/config'
import { startBackfill, getBackfillProgress } from '../src/sync/backfill'

// Seasons sourced from NBA CDN (all affected by the truncation bug)
const CDN_SEASONS = [2020, 2021, 2022, 2023, 2024, 2025, 2026]

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms))
}

async function pollUntilDone(jobId: string, seasonYear: number) {
    while (true) {
        await sleep(5000)
        const job = await getBackfillProgress(jobId)
        if (!job) {
            console.log(`[${seasonYear}] Job not found?`)
            return
        }
        const pct =
            job.total_items
                ? Math.round((job.completed_items / job.total_items) * 100)
                : 0
        console.log(
            `[${seasonYear}] ${job.status} — ${job.completed_items}/${job.total_items ?? '?'} games (${pct}%), ${job.failed_items} errors`,
        )
        if (job.status === 'completed' || job.status === 'failed') return
    }
}

async function main() {
    console.log(`Fixing minutes for seasons: ${CDN_SEASONS.join(', ')}`)
    console.log('Each season will forceResync all games from the NBA CDN.\n')

    for (const seasonYear of CDN_SEASONS) {
        console.log(`\n── Season ${seasonYear} ─────────────────────────────`)
        const jobId = await startBackfill(seasonYear, { forceResync: true })
        console.log(`[${seasonYear}] Job started: ${jobId}`)
        await pollUntilDone(jobId, seasonYear)
    }

    console.log('\nAll seasons done. Run REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_season_averages; to update averages.')
}

main().catch((e) => {
    console.error('Fatal:', e.message)
    process.exit(1)
})
