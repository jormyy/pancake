import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { requireOwnMember, verifyOwnMember } from '../lib/authz'
import { notifyMember } from '../lib/notifications'
import { NotFoundError, ValidationError } from '../plugins/errorHandler'
import { TradeActionBody, TradeParams, TradeProposeBody, TradeVetoBody } from '../schemas'

type TradeProposeRequest = {
    memberId: string
    leagueId: string
    leagueSeasonId: string
    recipientMemberId: string
    offerPlayerIds: string[]
    requestPlayerIds: string[]
    offerPickIds: string[]
    requestPickIds: string[]
    notes?: string
}

type TradeVetoRequest = {
    memberId: string
}

type TradeActionRequest = {
    memberId: string
    dropRosterPlayerIds?: string[]
}

type TradeVetoResult = {
    vetoed: boolean
    vetoCount: number
    threshold: number
    proposerMemberId: string
    recipientMemberId: string
}

export default async function tradeRoutes(app: FastifyInstance) {
    app.post(
        '/propose',
        { schema: { body: TradeProposeBody } },
        async (req) => {
            const {
                memberId,
                leagueId,
                leagueSeasonId,
                recipientMemberId,
                offerPlayerIds,
                requestPlayerIds,
                offerPickIds,
                requestPickIds,
                notes,
            } = req.body as TradeProposeRequest

            await verifyOwnMember(req.userId, memberId)

            const { data: tradeId, error } = await supabase.rpc('propose_trade_atomic', {
                p_league_id: leagueId,
                p_league_season_id: leagueSeasonId,
                p_proposer_member_id: memberId,
                p_recipient_member_id: recipientMemberId,
                p_offer_player_ids: offerPlayerIds,
                p_request_player_ids: requestPlayerIds,
                p_offer_pick_ids: offerPickIds,
                p_request_pick_ids: requestPickIds,
                p_notes: notes ?? null,
            })
            if (error || !tradeId) throw error ?? new Error('Could not create trade.')

            notifyMember(
                recipientMemberId,
                'New Trade Offer',
                'You have a new trade offer waiting for your review.',
                { tradeId },
            ).catch((error) => req.log.error({ err: error }, 'Trade proposal notification failed'))

            return { ok: true, tradeId }
        },
    )

    app.post(
        '/:tradeId/accept',
        { schema: { params: TradeParams, body: TradeActionBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId, dropRosterPlayerIds = [] } = req.body as TradeActionRequest

            const [, tradeRes] = await Promise.all([
                requireOwnMember(req.userId, memberId),
                supabase
                    .from('trades')
                    .select('id, proposer_member_id, recipient_member_id, status')
                    .eq('id', tradeId)
                    .eq('recipient_member_id', memberId)
                    .maybeSingle(),
            ])

            const { data: trade, error: fetchError } = tradeRes
            if (fetchError) throw fetchError
            if (!trade) throw new NotFoundError('Trade not found.')
            if (trade.status !== 'pending') {
                throw new ValidationError('This trade is no longer pending.')
            }

            const { error } = await supabase.rpc('accept_trade_atomic', {
                p_trade_id: tradeId,
                p_accepting_member_id: memberId,
                p_drop_roster_player_ids: dropRosterPlayerIds,
            })

            if (error) throw error

            if (trade) {
                Promise.all([
                    notifyMember(
                        trade.proposer_member_id,
                        'Trade Accepted',
                        'Your trade was accepted. The 24-hour veto window has opened — completion in <24h.',
                        { tradeId },
                    ),
                    notifyMember(
                        trade.recipient_member_id,
                        'Trade Acceptance Recorded',
                        'Your acceptance was recorded. The 24-hour veto window has opened — completion in <24h.',
                        { tradeId },
                    ),
                ]).catch((error) => req.log.error({ err: error }, 'Trade acceptance notification failed'))
            }

            return { ok: true }
        },
    )

    app.post(
        '/:tradeId/veto',
        { schema: { params: TradeParams, body: TradeVetoBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId } = req.body as TradeVetoRequest

            const { leagueId } = await requireOwnMember(req.userId, memberId)
            const { data: trade, error: tradeError } = await supabase
                .from('trades')
                .select('id')
                .eq('id', tradeId)
                .eq('league_id', leagueId)
                .maybeSingle()
            if (tradeError) throw tradeError
            if (!trade) throw new NotFoundError('Trade not found.')

            const { data, error } = await supabase.rpc('veto_trade_atomic', {
                p_trade_id: tradeId,
                p_member_id: memberId,
            })
            if (error || !data) throw error ?? new Error('Could not veto trade.')

            const result = data as TradeVetoResult
            if (result.vetoed) {
                await Promise.all([
                    notifyMember(
                        result.proposerMemberId,
                        'Trade Vetoed',
                        'An accepted trade was vetoed before completion.',
                        { tradeId },
                    ),
                    notifyMember(
                        result.recipientMemberId,
                        'Trade Vetoed',
                        'An accepted trade was vetoed before completion.',
                        { tradeId },
                    ),
                ]).catch((error) => req.log.error({ err: error }, 'Trade veto notification failed'))
            }

            return {
                ok: true,
                vetoed: result.vetoed,
                vetoCount: result.vetoCount,
                threshold: result.threshold,
            }
        },
    )

    app.post(
        '/:tradeId/reject',
        { schema: { params: TradeParams, body: TradeActionBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId } = req.body as { memberId: string }

            const [, tradeRes] = await Promise.all([
                requireOwnMember(req.userId, memberId),
                supabase
                    .from('trades')
                    .select('id, proposer_member_id, recipient_member_id, status')
                    .eq('id', tradeId)
                    .eq('recipient_member_id', memberId)
                    .maybeSingle(),
            ])

            const { data: trade, error: fetchError } = tradeRes
            if (fetchError) throw fetchError
            if (!trade) throw new NotFoundError('Trade not found.')
            if (trade.status !== 'pending') {
                throw new ValidationError('This trade is no longer pending.')
            }

            const { data: updatedTrade, error: updateError } = await supabase
                .from('trades')
                .update({ status: 'rejected' })
                .eq('id', tradeId)
                .eq('status', 'pending')
                .select('id')
                .maybeSingle()

            if (updateError) throw updateError
            if (!updatedTrade) {
                throw new ValidationError('This trade is no longer pending.')
            }

            notifyMember(
                trade.proposer_member_id,
                'Trade Rejected',
                'Your trade offer was declined.',
                { tradeId },
            ).catch((error) => req.log.error({ err: error }, 'Trade rejection notification failed'))

            return { ok: true }
        },
    )

    app.post(
        '/:tradeId/withdraw',
        { schema: { params: TradeParams, body: TradeActionBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId } = req.body as { memberId: string }

            const [, tradeRes] = await Promise.all([
                requireOwnMember(req.userId, memberId),
                supabase
                    .from('trades')
                    .select('id, proposer_member_id, recipient_member_id, status')
                    .eq('id', tradeId)
                    .eq('proposer_member_id', memberId)
                    .maybeSingle(),
            ])

            const { data: trade, error: fetchError } = tradeRes
            if (fetchError) throw fetchError
            if (!trade) throw new NotFoundError('Trade not found.')
            if (trade.status !== 'pending') {
                throw new ValidationError('This trade is no longer pending.')
            }

            const { data: updatedTrade, error: updateError } = await supabase
                .from('trades')
                .update({ status: 'withdrawn' })
                .eq('id', tradeId)
                .eq('status', 'pending')
                .select('id')
                .maybeSingle()

            if (updateError) throw updateError
            if (!updatedTrade) {
                throw new ValidationError('This trade is no longer pending.')
            }

            notifyMember(
                trade.recipient_member_id,
                'Trade Withdrawn',
                'A trade offer sent to you has been withdrawn.',
                { tradeId },
            ).catch((error) => req.log.error({ err: error }, 'Trade withdrawal notification failed'))

            return { ok: true }
        },
    )
}
