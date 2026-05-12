import { FastifyInstance } from 'fastify'
import { syncStatsByDate } from '../sync/stats'
import { syncScores } from '../sync/scores'
import { syncGameTimes } from '../sync/schedule'
import { syncPlayerStatuses } from '../sync/players'
import { generateAllMatchups } from '../sync/matchups'
import { processWaiverClaims } from '../sync/waivers'
import { advanceSeason } from '../sync/seasonReset'
import { startRookieDraft, autoPickBest } from '../sync/rookieDraft'
import { updateGameStatuses } from '../sync/livePoller'
import { fetchTodaysGames } from '../lib/nba'
import { ValidationError } from '../plugins/errorHandler'
import { LeagueIdBody, SyncMatchupsBody, DraftParams } from '../schemas'

const DateBody = {
    type: 'object' as const,
    properties: {
        date: { type: 'string' as const },
    },
}

const AutoPickBody = {
    type: 'object' as const,
    required: ['memberId'],
    properties: {
        memberId: { type: 'string' as const },
    },
}

function parseDate(value?: string): Date {
    const date = value ? new Date(value) : new Date()
    if (Number.isNaN(date.getTime())) {
        throw new ValidationError('date must be a valid ISO timestamp')
    }
    return date
}

export default async function e2eRoutes(app: FastifyInstance) {
    app.get('/status', async () => ({
        ok: true,
        nbaCdnBaseUrl: process.env.NBA_CDN_BASE_URL ?? null,
        sleeperBaseUrl: process.env.SLEEPER_BASE_URL ?? null,
        expoPushUrl: process.env.EXPO_PUSH_URL ?? null,
    }))

    app.post('/sync-schedule', async () => {
        const result = await syncGameTimes()
        return { ok: true, ...result }
    })

    app.post('/sync-players', async () => {
        await syncPlayerStatuses()
        return { ok: true }
    })

    app.post('/sync-stats', { schema: { body: DateBody } }, async (req) => {
        const { date } = (req.body ?? {}) as { date?: string }
        await syncStatsByDate(parseDate(date))
        return { ok: true }
    })

    app.post('/sync-scores', async () => {
        const games = await fetchTodaysGames()
        if (games.length > 0) await updateGameStatuses(games)
        await syncScores()
        return { ok: true, games: games.length }
    })

    app.post('/live-poll', { schema: { body: DateBody } }, async (req) => {
        const { date } = (req.body ?? {}) as { date?: string }
        const targetDate = parseDate(date)
        const games = await fetchTodaysGames()
        if (games.length > 0) await updateGameStatuses(games)
        await syncStatsByDate(targetDate)
        await syncScores()
        return { ok: true, games: games.length }
    })

    app.post('/process-waivers', async () => {
        await processWaiverClaims()
        return { ok: true }
    })

    app.post('/generate-matchups', { schema: { body: SyncMatchupsBody } }, async (req) => {
        const { force = false, leagueId } = (req.body ?? {}) as { force?: boolean; leagueId?: string }
        await generateAllMatchups(force, leagueId)
        return { ok: true }
    })

    app.post('/advance-season', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        const result = await advanceSeason(leagueId)
        return { ok: true, ...result }
    })

    app.post('/start-rookie-draft', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        const draft = await startRookieDraft(leagueId)
        return { ok: true, draft }
    })

    app.post('/:draftId/auto-pick', { schema: { params: DraftParams, body: AutoPickBody } }, async (req) => {
        const { draftId } = req.params as { draftId: string }
        const { memberId } = req.body as { memberId: string }
        const result = await autoPickBest(draftId, memberId)
        return { ok: true, ...result }
    })
}
