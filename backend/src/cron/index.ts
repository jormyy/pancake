import { CONFIG } from '../config'
import { closeExpiredNominations } from '../sync/draft'
import { livePoller } from '../sync/livePoller'
import { syncPlayerStatuses } from '../sync/players'
import { processAcceptedTrades } from '../sync/trades'

// ── Cron job ownership ────────────────────────────────────────
//
// pg_cron + Edge Functions own all scheduled NBA data syncs:
//   nba-sync-players      → sync-players    Edge Function  (daily 6 AM ET)
//   nba-sync-schedule     → sync-schedule   Edge Function  (daily 6:05 AM ET)
//   nba-sync-projections  → sync-projections Edge Function (daily 8 AM ET)
//   nba-sync-rankings     → sync-rankings   Edge Function  (weekly Mon 7 AM ET)
//   nba-process-waivers   → process-waivers Edge Function  (daily 3 AM ET)
//   nba-live-poll         → live-poll       Edge Function  (every min, game hours)
//
// The Fastify backend owns only interactive/real-time operations:
//   closeExpiredNominations — must run frequently (every 10s) to close
//     auction countdown timers; too latency-sensitive for pg_cron (1-min min).
//   livePoller — adaptive poller that switches from idle (5 min) to active
//     (30s stats / 60s scores) when live games are detected. Provides a
//     faster feedback loop than the Edge Function cron during game windows.
//   processAcceptedTrades — finalizes trades whose 24h veto window has
//     expired. Runs every 5 min in-process so accepted trades don't pile up
//     between Edge Function invocations.

export function registerCronJobs() {
    // Every 10s — close expired auction nominations
    setInterval(async () => {
        await closeExpiredNominations().catch(console.error)
    }, CONFIG.NOMINATION_POLL_INTERVAL_MS)

    // Adaptive live-game poller
    livePoller.start()

    // Sync player injury statuses every 30 minutes
    syncPlayerStatuses().catch(console.error)
    setInterval(() => syncPlayerStatuses().catch(console.error), CONFIG.PLAYER_STATUS_SYNC_MS)

    // Every 5 min — complete accepted trades whose veto window has expired
    setInterval(() => {
        processAcceptedTrades()
            .then((result) => {
                if (result.processed > 0 || result.failed > 0) {
                    console.log(
                        `[cron] processAcceptedTrades: processed=${result.processed} failed=${result.failed}`,
                    )
                }
                if (result.failures.length > 0) {
                    for (const f of result.failures) console.error(`[cron] trade failure: ${f}`)
                }
            })
            .catch((err) => console.error('[cron] processAcceptedTrades error:', err))
    }, CONFIG.TRADE_COMPLETION_INTERVAL_MS)
}
