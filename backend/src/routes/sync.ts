import { FastifyInstance } from 'fastify'
import { syncStatsByDate } from '../sync/stats'
import { generateAllMatchups } from '../sync/matchups'
import { syncScores } from '../sync/scores'
import { updateGameStatuses } from '../sync/livePoller'
import { fetchTodaysGames } from '../lib/nba'
import { startBackfill, getBackfillProgress, startFullHistoricalBackfill } from '../sync/backfill'
import { testNBAEndpoints } from '../sync/healthCheck'
import { verifySampleStats, verifySeasonTotals, validateDatabase } from '../sync/verify'
import { currentSeasonYear } from '../lib/utils/season'
import { syncPlayerStatuses } from '../sync/players'
import { syncDraftOrder } from '../sync/draftOrder'
import { syncGameTimes } from '../sync/schedule'
import { NotFoundError } from '../plugins/errorHandler'
import {
    SyncStatsBody,
    SyncMatchupsBody,
    BackfillBody,
    BackfillParams,
    VerifyStatsBody,
    ValidateDbBody,
} from '../schemas'

function parseQuerySeasonYear(query: any): number {
    return query?.seasonYear ? parseInt(query.seasonYear) : currentSeasonYear()
}

export default async function syncRoutes(app: FastifyInstance) {
    app.post('/stats', { schema: { body: SyncStatsBody } }, async (req) => {
        const { days = 1 } = req.body as { days?: number }
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date()
            d.setDate(d.getDate() - i)
            await syncStatsByDate(d)
        }
        return { ok: true }
    })

    app.post('/matchups', { schema: { body: SyncMatchupsBody } }, async (req) => {
        const { force = false } = req.body as { force?: boolean }
        await generateAllMatchups(force)
        return { ok: true }
    })

    app.post('/players', async () => {
        await syncPlayerStatuses()
        return { ok: true }
    })

    app.post('/draft-order', async (req) => {
        const { seasonYear = new Date().getFullYear() } = (req.body ?? {}) as { seasonYear?: number }
        const result = await syncDraftOrder(seasonYear)
        return { ok: true, ...result }
    })

    app.post('/scores', async () => {
        const games = await fetchTodaysGames()
        if (games.length) await updateGameStatuses(games)
        await syncScores()
        return { ok: true }
    })

    app.post('/schedule', async () => {
        const result = await syncGameTimes()
        return { ok: true, ...result }
    })

    // ── NBA data backfill ─────────────────────────────────────────

    // Start a background backfill for a full season (or date range)
    // Body: { seasonYear: number, fromDate?: string, toDate?: string, forceResync?: boolean }
    app.post('/backfill', { schema: { body: BackfillBody } }, async (req) => {
        const { seasonYear, fromDate, toDate, forceResync = false } = req.body as {
            seasonYear: number
            fromDate?: string
            toDate?: string
            forceResync?: boolean
        }
        const jobId = await startBackfill(seasonYear, { fromDate, toDate, forceResync })
        return { ok: true, jobId }
    })

    // Poll backfill progress
    app.get('/backfill/:jobId', { schema: { params: BackfillParams } }, async (req) => {
        const { jobId } = req.params as { jobId: string }
        const job = await getBackfillProgress(jobId)
        if (!job) {
            throw new NotFoundError('Job not found')
        }
        return job
    })

    // ── Testing + verification ────────────────────────────────────

    // Test all NBA CDN endpoints and report status/latency
    app.post('/test-endpoints', async () => {
        const results = await testNBAEndpoints()
        return { ok: true, results }
    })

    // Cross-reference sample games against CDN — reports any field mismatches
    app.post('/verify-stats', { schema: { body: VerifyStatsBody } }, async (req) => {
        const { sampleSize = 10 } = (req.body as { sampleSize?: number }) ?? {}
        const result = await verifySampleStats(sampleSize)
        return { ok: true, ...result }
    })

    // Season totals for top players (manual cross-reference against nba.com/basketball-reference)
    app.get('/season-totals', async (req) => {
        const seasonYear = parseQuerySeasonYear(req.query)
        const rows = await verifySeasonTotals(seasonYear)
        return { ok: true, seasonYear, rows }
    })

    // Check DB completeness — missing stats, missing nba_game_ids, etc.
    app.post('/validate-db', { schema: { body: ValidateDbBody } }, async (req) => {
        const { seasonYear } = (req.body as { seasonYear?: number }) ?? {}
        const report = await validateDatabase(seasonYear)
        return { ok: true, ...report }
    })
}
