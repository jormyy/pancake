import { FastifyInstance } from 'fastify'
import {
    startDraft,
    nominatePlayer,
    placeBid,
    getDraftState,
} from '../sync/draft'
import {
    startRookieDraft,
    makeSnakePick,
    getRookieDraftState,
    reseedRookieDraftPicks,
    autoPickBest,
} from '../sync/rookieDraft'
import { NotFoundError } from '../plugins/errorHandler'
import { verifyMemberAccess } from '../lib/authz'
import {
    LeagueIdBody,
    DraftParams,
    NominateBody,
    BidBody,
    SnakePickBody,
} from '../schemas'

export default async function draftRoutes(app: FastifyInstance) {
    app.post('/start', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        const draft = await startDraft(leagueId)
        return { ok: true, draft }
    })

    app.get('/:draftId', { schema: { params: DraftParams } }, async (req) => {
        const { draftId } = req.params as { draftId: string }
        const state = await getDraftState(draftId)
        return { ok: true, ...state }
    })

    app.post(
        '/:draftId/nominate',
        {
            schema: { params: DraftParams, body: NominateBody },
            config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, playerId } = req.body as { memberId: string; playerId: string }
            await verifyMemberAccess(req.userId, memberId)
            const nomination = await nominatePlayer(draftId, memberId, playerId)
            return { ok: true, nomination }
        },
    )

    app.post(
        '/:draftId/bid',
        {
            schema: { params: DraftParams, body: BidBody },
            config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, nominationId, amount } = req.body as {
                memberId: string
                nominationId: string
                amount: number
            }
            await verifyMemberAccess(req.userId, memberId)
            return await placeBid(draftId, memberId, nominationId, amount)
        },
    )

    // ── Rookie draft routes ──────────────────────────────────────

    app.post('/start-rookie', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        const draft = await startRookieDraft(leagueId)
        return { ok: true, draft }
    })

    app.get(
        '/:draftId/rookie-state',
        { schema: { params: DraftParams } },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const state = await getRookieDraftState(draftId)
            if (!state) {
                throw new NotFoundError('Draft not found')
            }
            return { ok: true, ...state }
        },
    )

    app.post(
        '/:draftId/auto-pick',
        { schema: { params: DraftParams, body: SnakePickBody } },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId } = req.body as { memberId: string }
            await verifyMemberAccess(req.userId, memberId)
            const result = await autoPickBest(draftId, memberId)
            return { ok: true, ...result }
        },
    )

    app.post(
        '/:draftId/reseed-picks',
        { schema: { params: DraftParams } },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const result = await reseedRookieDraftPicks(draftId)
            return { ok: true, ...result }
        },
    )

    app.post(
        '/:draftId/snake-pick',
        { schema: { params: DraftParams, body: SnakePickBody } },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, playerId } = req.body as { memberId: string; playerId: string }
            await verifyMemberAccess(req.userId, memberId)
            const result = await makeSnakePick(draftId, memberId, playerId)
            return { ok: true, ...result }
        },
    )
}
