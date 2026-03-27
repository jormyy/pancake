import cron from 'node-cron'
import { CONFIG } from '../config'
import { syncPlayers } from '../sync/players'
import { syncSchedule } from '../sync/games'
import { syncStatsByDate } from '../sync/stats'
import { syncProjectionsByDate } from '../sync/projections'
import { syncScores } from '../sync/scores'
import { syncDynastyRankings } from '../sync/rankings'
import { processWaiverClaims } from '../sync/waivers'
import { closeExpiredNominations } from '../sync/draft'

const TZ = { timezone: CONFIG.CRON_TIMEZONE }

export function registerCronJobs() {
    // 6 AM ET — daily player + schedule sync
    cron.schedule('0 6 * * *', async () => {
        console.log('[cron] Running daily player sync...')
        await syncPlayers().catch(console.error)
    }, TZ)

    cron.schedule('0 6 * * *', async () => {
        console.log('[cron] Running daily schedule sync...')
        await syncSchedule().catch(console.error)
    }, TZ)

    // Hourly noon–midnight ET — stats sync
    cron.schedule('0 12-23,0 * * *', async () => {
        console.log('[cron] Running stats sync...')
        await syncStatsByDate(new Date()).catch(console.error)
    }, TZ)

    // 8 AM ET — projections sync
    cron.schedule('0 8 * * *', async () => {
        console.log('[cron] Running projections sync...')
        await syncProjectionsByDate(new Date()).catch(console.error)
    }, TZ)

    // Every 15 min noon–midnight ET — score sync
    cron.schedule('*/15 12-23,0 * * *', async () => {
        console.log('[cron] Running score sync...')
        await syncScores().catch(console.error)
    }, TZ)

    // 7 AM Monday ET — dynasty rankings
    cron.schedule('0 7 * * 1', async () => {
        console.log('[cron] Running dynasty rankings sync...')
        await syncDynastyRankings().catch(console.error)
    }, TZ)

    // 3 AM ET — waiver claims
    cron.schedule('0 3 * * *', async () => {
        console.log('[cron] Processing waiver claims...')
        await processWaiverClaims().catch(console.error)
    }, TZ)

    // Every 10s — close expired auction nominations
    setInterval(async () => {
        await closeExpiredNominations().catch(console.error)
    }, CONFIG.NOMINATION_POLL_INTERVAL_MS)
}
