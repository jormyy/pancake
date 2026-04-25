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
import { requireAdmin } from '../lib/authz'
import {
    SyncStatsBody,
    SyncMatchupsBody,
    BackfillBody,
    BackfillParams,
    VerifyStatsBody,
    ValidateDbBody,
    DraftOrderBody,
} from '../schemas'

function parseQuerySeasonYear(query: Record<string, string | undefined>): number {
    return query?.seasonYear ? parseInt(query.seasonYear) : currentSeasonYear()
}

export default async function syncRoutes(app: FastifyInstance) {
    app.post('/stats', { schema: { body: SyncStatsBody } }, async (req) => {
        requireAdmin(req.userId)
        const { days = 1 } = req.body as { days?: number }
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date()
            d.setDate(d.getDate() - i)
            await syncStatsByDate(d)
        }
        return { ok: true }
    })

    app.post('/matchups', { schema: { body: SyncMatchupsBody } }, async (req) => {
        requireAdmin(req.userId)
        const { force = false } = req.body as { force?: boolean }
        await generateAllMatchups(force)
        return { ok: true }
    })

    app.post('/players', async (req) => {
        requireAdmin(req.userId)
        await syncPlayerStatuses()
        return { ok: true }
    })

    app.post('/draft-order', { schema: { body: DraftOrderBody } }, async (req) => {
        requireAdmin(req.userId)
        const { seasonYear = new Date().getFullYear() } = (req.body ?? {}) as { seasonYear?: number }
        const result = await syncDraftOrder(seasonYear)
        return { ok: true, ...result }
    })

    app.post('/scores', async (req) => {
        requireAdmin(req.userId)
        const games = await fetchTodaysGames()
        if (games.length) await updateGameStatuses(games)
        await syncScores()
        return { ok: true }
    })

    app.post('/schedule', async (req) => {
        requireAdmin(req.userId)
        const result = await syncGameTimes()
        return { ok: true, ...result }
    })

    // ── NBA data backfill ─────────────────────────────────────────

    // Start a background backfill for a full season (or date range)
    // Body: { seasonYear: number, fromDate?: string, toDate?: string, forceResync?: boolean }
    app.post('/backfill', { schema: { body: BackfillBody } }, async (req) => {
        requireAdmin(req.userId)
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
        requireAdmin(req.userId)
        const { jobId } = req.params as { jobId: string }
        const job = await getBackfillProgress(jobId)
        if (!job) {
            throw new NotFoundError('Job not found')
        }
        return job
    })

    // ── Testing + verification ────────────────────────────────────

    // Test all NBA CDN endpoints and report status/latency
    app.post('/test-endpoints', async (req) => {
        requireAdmin(req.userId)
        const results = await testNBAEndpoints()
        return { ok: true, results }
    })

    // Cross-reference sample games against CDN — reports any field mismatches
    app.post('/verify-stats', { schema: { body: VerifyStatsBody } }, async (req) => {
        requireAdmin(req.userId)
        const { sampleSize = 10 } = (req.body as { sampleSize?: number }) ?? {}
        const result = await verifySampleStats(sampleSize)
        return { ok: true, ...result }
    })

    // Season totals for top players (manual cross-reference against nba.com/basketball-reference)
    app.get('/season-totals', async (req) => {
        requireAdmin(req.userId)
        const seasonYear = parseQuerySeasonYear(req.query as Record<string, string | undefined>)
        const rows = await verifySeasonTotals(seasonYear)
        return { ok: true, seasonYear, rows }
    })

    // Check DB completeness — missing stats, missing nba_game_ids, etc.
    app.post('/validate-db', { schema: { body: ValidateDbBody } }, async (req) => {
        requireAdmin(req.userId)
        const { seasonYear } = (req.body as { seasonYear?: number }) ?? {}
        const report = await validateDatabase(seasonYear)
        return { ok: true, ...report }
    })
}
