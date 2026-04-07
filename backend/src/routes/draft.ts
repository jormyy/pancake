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
} from '../sync/rookieDraft'
import {
    LeagueIdBody,
    DraftParams,
    NominateBody,
    BidBody,
    SnakePickBody,
} from '../schemas'

function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message
    if (typeof e === 'object' && e !== null && 'details' in e) return String((e as any).details)
    return JSON.stringify(e) || 'Unknown error'
}

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
        { schema: { params: DraftParams, body: NominateBody } },
        async (req, reply) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, playerId } = req.body as { memberId: string; playerId: string }
            try {
                const nomination = await nominatePlayer(draftId, memberId, playerId)
                return { ok: true, nomination }
            } catch (e) {
                reply.status(400)
                return { ok: false, error: errMsg(e) }
            }
        },
    )

    app.post(
        '/:draftId/bid',
        { schema: { params: DraftParams, body: BidBody } },
        async (req, reply) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, nominationId, amount } = req.body as {
                memberId: string
                nominationId: string
                amount: number
            }
            try {
                return await placeBid(draftId, memberId, nominationId, amount)
            } catch (e) {
                reply.status(400)
                return { ok: false, error: errMsg(e) }
            }
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
        async (req, reply) => {
            const { draftId } = req.params as { draftId: string }
            const state = await getRookieDraftState(draftId)
            if (!state) {
                reply.status(404)
                return { ok: false, error: 'Draft not found' }
            }
            return { ok: true, ...state }
        },
    )

    app.post(
        '/:draftId/reseed-picks',
        { schema: { params: DraftParams } },
        async (req, reply) => {
            const { draftId } = req.params as { draftId: string }
            try {
                const result = await reseedRookieDraftPicks(draftId)
                return { ok: true, ...result }
            } catch (e) {
                reply.status(400)
                return { ok: false, error: errMsg(e) }
            }
        },
    )

    app.post(
        '/:draftId/snake-pick',
        { schema: { params: DraftParams, body: SnakePickBody } },
        async (req, reply) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, playerId } = req.body as { memberId: string; playerId: string }
            try {
                const result = await makeSnakePick(draftId, memberId, playerId)
                return { ok: true, ...result }
            } catch (e) {
                reply.status(400)
                return { ok: false, error: errMsg(e) }
            }
        },
    )
}
