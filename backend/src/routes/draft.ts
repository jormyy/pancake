import { FastifyInstance } from 'fastify'
import {
    startDraft,
    stopDraft,
    resetDraft,
    nominatePlayer,
    placeBid,
    withdrawNomination,
} from '../sync/draft'
import {
    startRookieDraft,
    makeSnakePick,
    reseedRookieDraftPicks,
    autoPickBest,
} from '../sync/rookieDraft'
import { requireCommissioner, requireCommissionerForDraft, verifyOwnMember } from '../lib/authz'
import {
    LeagueIdBody,
    StartDraftBody,
    DraftParams,
    NominateBody,
    BidBody,
    WithdrawNominationBody,
    SnakePickBody,
    AutoPickBody,
} from '../schemas'
import type { NominationOrderMode } from '../sync/draft'

export default async function draftRoutes(app: FastifyInstance) {
    app.post('/start', { schema: { body: StartDraftBody } }, async (req) => {
        const { leagueId, nominationOrderMode } = req.body as {
            leagueId: string
            nominationOrderMode?: NominationOrderMode
        }
        await requireCommissioner(req.userId, leagueId)
        const draft = await startDraft(leagueId, nominationOrderMode)
        return { ok: true, draft }
    })

    app.post('/:draftId/stop', { schema: { params: DraftParams } }, async (req) => {
        const { draftId } = req.params as { draftId: string }
        await requireCommissionerForDraft(req.userId, draftId)
        return await stopDraft(draftId)
    })

    app.post('/:draftId/reset', { schema: { params: DraftParams } }, async (req) => {
        const { draftId } = req.params as { draftId: string }
        await requireCommissionerForDraft(req.userId, draftId)
        return await resetDraft(draftId)
    })

    // NOTE: draft state is read client-side via RLS-scoped Supabase queries
    // (lib/draft.ts, lib/rookieDraft.ts). There is deliberately NO backend
    // GET draft-state route: the only safe reader is the per-user RLS client.
    // A service-role GET here would bypass RLS and leak any league's private
    // draft state (budgets/bids/picks) to any authenticated user.

    app.post(
        '/:draftId/nominate',
        {
            schema: { params: DraftParams, body: NominateBody },
            config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, playerId } = req.body as { memberId: string; playerId: string }
            await verifyOwnMember(req.userId, memberId)
            const nomination = await nominatePlayer(draftId, memberId, playerId, req.userId)
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
            await verifyOwnMember(req.userId, memberId)
            return await placeBid(draftId, memberId, nominationId, amount, req.userId)
        },
    )

    app.post(
        '/:draftId/withdraw-nomination',
        {
            schema: { params: DraftParams, body: WithdrawNominationBody },
            config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId, nominationId } = req.body as { memberId: string; nominationId: string }
            await verifyOwnMember(req.userId, memberId)
            return await withdrawNomination(draftId, memberId, nominationId, req.userId)
        },
    )

    app.post('/start-rookie', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        await requireCommissioner(req.userId, leagueId)
        const draft = await startRookieDraft(leagueId)
        return { ok: true, draft }
    })

    app.post(
        '/:draftId/auto-pick',
        { schema: { params: DraftParams, body: AutoPickBody } },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            const { memberId } = req.body as { memberId: string }
            await verifyOwnMember(req.userId, memberId)
            const result = await autoPickBest(draftId, memberId)
            return { ok: true, ...result }
        },
    )

    app.post(
        '/:draftId/reseed-picks',
        { schema: { params: DraftParams } },
        async (req) => {
            const { draftId } = req.params as { draftId: string }
            await requireCommissionerForDraft(req.userId, draftId)
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
            await verifyOwnMember(req.userId, memberId)
            const result = await makeSnakePick(draftId, memberId, playerId)
            return { ok: true, ...result }
        },
    )
}
