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
import { supabase } from '../lib/supabase'
import { AppError, NotFoundError } from '../plugins/errorHandler'
import {
    LeagueIdBody,
    DraftParams,
    NominateBody,
    BidBody,
    SnakePickBody,
} from '../schemas'

/**
 * Verify the requesting user owns the memberId or is a commissioner.
 */
async function verifyMemberAccess(userId: string, memberId: string): Promise<void> {
    const { data, error } = await supabase
        .from('league_members')
        .select('user_id, role, league_id')
        .eq('id', memberId)
        .single()

    if (error || !data) {
        throw new NotFoundError('Member not found')
    }

    if (data.user_id === userId) return

    // Allow commissioners
    const { data: commissioner } = await supabase
        .from('league_members')
        .select('role')
        .eq('league_id', data.league_id)
        .eq('user_id', userId)
        .in('role', ['commissioner', 'co_commissioner'])
        .maybeSingle()

    if (!commissioner) {
        throw new AppError('Not authorized', 403)
    }
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
        async (req, reply) => {
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
