import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { verifyOwnMember } from '../lib/authz'
import { notifyMember } from '../lib/notifications'
import { AppError, NotFoundError, ValidationError } from '../plugins/errorHandler'
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

function assertNoDuplicates(ids: string[], label: string) {
    if (new Set(ids).size !== ids.length) {
        throw new ValidationError(`Duplicate ${label} are not allowed.`)
    }
}

function todayET(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

async function assertRosterPlayersOwned(
    playerIds: string[],
    {
        leagueId,
        leagueSeasonId,
        memberId,
        label,
    }: { leagueId: string; leagueSeasonId: string; memberId: string; label: string },
) {
    if (playerIds.length === 0) return

    const { data, error } = await supabase
        .from('roster_players')
        .select('player_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('member_id', memberId)
        .in('player_id', playerIds)

    if (error) throw error
    if ((data ?? []).length !== playerIds.length) {
        throw new ValidationError(`${label} includes a player that is no longer owned by the expected team.`)
    }
}

async function assertDraftPicksOwned(
    pickIds: string[],
    {
        leagueId,
        memberId,
        label,
    }: { leagueId: string; memberId: string; label: string },
) {
    if (pickIds.length === 0) return

    const { data, error } = await supabase
        .from('draft_picks')
        .select('id')
        .eq('league_id', leagueId)
        .eq('current_owner_id', memberId)
        .eq('is_used', false)
        .in('id', pickIds)

    if (error) throw error
    if ((data ?? []).length !== pickIds.length) {
        throw new ValidationError(`${label} includes a draft pick that is no longer owned by the expected team.`)
    }
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

            if (memberId === recipientMemberId) {
                throw new ValidationError('You cannot trade with yourself.')
            }
            const hasOfferAssets = offerPlayerIds.length > 0 || offerPickIds.length > 0
            const hasRequestAssets = requestPlayerIds.length > 0 || requestPickIds.length > 0
            if (!hasOfferAssets || !hasRequestAssets) {
                throw new ValidationError('A trade must include at least one asset on each side.')
            }
            assertNoDuplicates(offerPlayerIds, 'offered players')
            assertNoDuplicates(requestPlayerIds, 'requested players')
            assertNoDuplicates(offerPickIds, 'offered picks')
            assertNoDuplicates(requestPickIds, 'requested picks')

            const { data: league, error: leagueErr } = await supabase
                .from('leagues')
                .select('id, trade_deadline')
                .eq('id', leagueId)
                .single()
            if (leagueErr || !league) throw new NotFoundError('League not found.')
            if (league.trade_deadline && league.trade_deadline < todayET()) {
                throw new ValidationError('The trade deadline has passed.')
            }

            const [{ data: proposer }, { data: recipient }, { data: season }] = await Promise.all([
                supabase
                    .from('league_members')
                    .select('id, league_id')
                    .eq('id', memberId)
                    .single(),
                supabase
                    .from('league_members')
                    .select('id, league_id')
                    .eq('id', recipientMemberId)
                    .single(),
                supabase
                    .from('league_seasons')
                    .select('id, league_id, is_current')
                    .eq('id', leagueSeasonId)
                    .single(),
            ])

            if (!proposer) throw new NotFoundError('Proposer not found.')
            if (!recipient) throw new NotFoundError('Recipient not found.')
            if (!season) throw new ValidationError('No active season found.')
            if (
                proposer.league_id !== leagueId ||
                recipient.league_id !== leagueId ||
                season.league_id !== leagueId
            ) {
                throw new AppError('Access denied', 403)
            }
            if (!season.is_current) {
                throw new ValidationError('No active season found.')
            }

            await Promise.all([
                assertRosterPlayersOwned(offerPlayerIds, {
                    leagueId,
                    leagueSeasonId,
                    memberId,
                    label: 'Your offer',
                }),
                assertRosterPlayersOwned(requestPlayerIds, {
                    leagueId,
                    leagueSeasonId,
                    memberId: recipientMemberId,
                    label: 'Your request',
                }),
                assertDraftPicksOwned(offerPickIds, {
                    leagueId,
                    memberId,
                    label: 'Your offer',
                }),
                assertDraftPicksOwned(requestPickIds, {
                    leagueId,
                    memberId: recipientMemberId,
                    label: 'Your request',
                }),
            ])

            const { data: trade, error: tradeError } = await supabase
                .from('trades')
                .insert({
                    league_id: leagueId,
                    league_season_id: leagueSeasonId,
                    proposer_member_id: memberId,
                    recipient_member_id: recipientMemberId,
                    notes: notes?.trim() ? notes.trim() : null,
                    status: 'pending',
                })
                .select('id')
                .single()
            if (tradeError || !trade) throw tradeError ?? new Error('Could not create trade.')

            const items: {
                trade_id: string
                side: 'proposer' | 'recipient'
                player_id: string | null
                pick_id: string | null
            }[] = [
                ...offerPlayerIds.map((playerId) => ({
                    trade_id: trade.id,
                    side: 'proposer' as const,
                    player_id: playerId,
                    pick_id: null,
                })),
                ...requestPlayerIds.map((playerId) => ({
                    trade_id: trade.id,
                    side: 'recipient' as const,
                    player_id: playerId,
                    pick_id: null,
                })),
                ...offerPickIds.map((pickId) => ({
                    trade_id: trade.id,
                    side: 'proposer' as const,
                    player_id: null,
                    pick_id: pickId,
                })),
                ...requestPickIds.map((pickId) => ({
                    trade_id: trade.id,
                    side: 'recipient' as const,
                    player_id: null,
                    pick_id: pickId,
                })),
            ]

            const { error: itemError } = await supabase.from('trade_items').insert(items)
            if (itemError) {
                await supabase.from('trades').delete().eq('id', trade.id)
                throw itemError
            }

            notifyMember(
                recipientMemberId,
                'New Trade Offer',
                'You have a new trade offer waiting for your review.',
                { tradeId: trade.id },
            ).catch((error) => req.log.error({ err: error }, 'Trade proposal notification failed'))

            return { ok: true, tradeId: trade.id }
        },
    )

    app.post(
        '/:tradeId/accept',
        { schema: { params: TradeParams, body: TradeActionBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId } = req.body as { memberId: string }

            await verifyOwnMember(req.userId, memberId)

            const { error } = await supabase.rpc('accept_trade_atomic', {
                p_trade_id: tradeId,
                p_accepting_member_id: memberId,
            })

            if (error) throw error

            return { ok: true }
        },
    )

    app.post(
        '/:tradeId/veto',
        { schema: { params: TradeParams, body: TradeVetoBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId } = req.body as TradeVetoRequest

            await verifyOwnMember(req.userId, memberId)

            const { data: trade, error: tradeError } = await supabase
                .from('trades')
                .select('id, league_id, proposer_member_id, recipient_member_id, status, veto_window_expires_at')
                .eq('id', tradeId)
                .single()
            if (tradeError || !trade) throw new NotFoundError('Trade not found.')

            if (trade.status !== 'accepted') {
                throw new ValidationError('This trade is not in its veto window.')
            }
            if (!trade.veto_window_expires_at || new Date(trade.veto_window_expires_at) <= new Date()) {
                throw new ValidationError('The veto window has expired.')
            }

            const { data: member, error: memberError } = await supabase
                .from('league_members')
                .select('id, league_id, role')
                .eq('id', memberId)
                .single()
            if (memberError || !member) throw new NotFoundError('League member not found.')
            if (member.league_id !== trade.league_id) {
                throw new AppError('Access denied', 403)
            }

            const isCommissioner = member.role === 'commissioner' || member.role === 'co_commissioner'
            const isTradeParty = member.id === trade.proposer_member_id || member.id === trade.recipient_member_id
            if (isTradeParty && !isCommissioner) {
                throw new ValidationError('Trade parties cannot veto their own trade.')
            }

            const { error: insertError } = await supabase
                .from('trade_vetos')
                .insert({
                    trade_id: tradeId,
                    member_id: memberId,
                    veto_type: isCommissioner ? 'commissioner' : 'member',
                })
            if (insertError) {
                if (insertError.code === '23505') {
                    throw new ValidationError('You have already vetoed this trade.')
                }
                throw insertError
            }

            const [{ count: memberVetoCount, error: vetoCountError }, { count: eligibleCount, error: eligibleError }] = await Promise.all([
                supabase
                    .from('trade_vetos')
                    .select('id', { count: 'exact', head: true })
                    .eq('trade_id', tradeId)
                    .eq('veto_type', 'member'),
                supabase
                    .from('league_members')
                    .select('id', { count: 'exact', head: true })
                    .eq('league_id', trade.league_id)
                    .not('id', 'in', `(${trade.proposer_member_id},${trade.recipient_member_id})`),
            ])
            if (vetoCountError) throw vetoCountError
            if (eligibleError) throw eligibleError

            const threshold = Math.max(1, Math.ceil((eligibleCount ?? 0) / 2))
            const vetoed = isCommissioner || (memberVetoCount ?? 0) >= threshold
            if (vetoed) {
                const { error: updateError } = await supabase
                    .from('trades')
                    .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
                    .eq('id', tradeId)
                    .eq('status', 'accepted')
                if (updateError) throw updateError

                await Promise.all([
                    notifyMember(
                        trade.proposer_member_id,
                        'Trade Vetoed',
                        'An accepted trade was vetoed before completion.',
                        { tradeId },
                    ),
                    notifyMember(
                        trade.recipient_member_id,
                        'Trade Vetoed',
                        'An accepted trade was vetoed before completion.',
                        { tradeId },
                    ),
                ]).catch((error) => req.log.error({ err: error }, 'Trade veto notification failed'))
            }

            return {
                ok: true,
                vetoed,
                vetoCount: memberVetoCount ?? 0,
                threshold,
            }
        },
    )

    app.post(
        '/:tradeId/reject',
        { schema: { params: TradeParams, body: TradeActionBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId } = req.body as { memberId: string }

            await verifyOwnMember(req.userId, memberId)

            const { data: trade, error: fetchError } = await supabase
                .from('trades')
                .select('id, proposer_member_id, recipient_member_id, status')
                .eq('id', tradeId)
                .single()

            if (fetchError || !trade) throw new NotFoundError('Trade not found.')
            if (trade.recipient_member_id !== memberId) {
                throw new AppError('Only the recipient can reject this trade.', 403)
            }
            if (trade.status !== 'pending') {
                throw new ValidationError('This trade is no longer pending.')
            }

            const { error: updateError } = await supabase
                .from('trades')
                .update({ status: 'rejected' })
                .eq('id', tradeId)
                .eq('status', 'pending')

            if (updateError) throw updateError

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

            await verifyOwnMember(req.userId, memberId)

            const { data: trade, error: fetchError } = await supabase
                .from('trades')
                .select('id, proposer_member_id, recipient_member_id, status')
                .eq('id', tradeId)
                .single()

            if (fetchError || !trade) throw new NotFoundError('Trade not found.')
            if (trade.proposer_member_id !== memberId) {
                throw new AppError('Only the proposer can withdraw this trade.', 403)
            }
            if (trade.status !== 'pending') {
                throw new ValidationError('This trade is no longer pending.')
            }

            const { error: updateError } = await supabase
                .from('trades')
                .update({ status: 'withdrawn' })
                .eq('id', tradeId)
                .eq('status', 'pending')

            if (updateError) throw updateError

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
