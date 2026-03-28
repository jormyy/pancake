import { supabase } from '@/lib/supabase'
import { logTransaction } from '@/lib/transactions'
import { apiPost } from '@/lib/shared/api'

export type TradePlayerItem = {
    kind: 'player'
    playerId: string
    playerName: string
    position: string | null
    nbaTeam: string | null
}

export type TradePickItem = {
    kind: 'pick'
    pickId: string
    seasonYear: number
    round: number
    originalTeamName: string
}

export type TradeItem = TradePlayerItem | TradePickItem

export type Trade = {
    id: string
    status: string
    proposedAt: string
    notes: string | null
    proposerMemberId: string
    proposerTeamName: string
    recipientMemberId: string
    recipientTeamName: string
    // Items the proposer is giving (recipient receives)
    proposerGives: TradeItem[]
    // Items the recipient is giving (proposer receives)
    recipientGives: TradeItem[]
}

export async function getPicksForMember(memberId: string, leagueId: string): Promise<TradePickItem[]> {
    const { data, error } = await (supabase as any)
        .from('draft_picks')
        .select(`
            id,
            season_year,
            round,
            original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
        `)
        .eq('current_owner_id', memberId)
        .eq('league_id', leagueId)
        .eq('is_used', false)
        .order('season_year', { ascending: true })
        .order('round', { ascending: true })

    if (error) throw error

    return (data ?? []).map((row: any) => ({
        kind: 'pick' as const,
        pickId: row.id,
        seasonYear: row.season_year,
        round: row.round,
        originalTeamName: row.original_owner?.team_name ?? 'Unknown',
    }))
}

export async function proposeTrade(
    memberId: string,
    leagueId: string,
    seasonId: string,
    recipientMemberId: string,
    offerPlayerIds: string[],
    requestPlayerIds: string[],
    offerPickIds: string[],
    requestPickIds: string[],
    notes?: string,
): Promise<string> {
    const hasOfferAssets = offerPlayerIds.length > 0 || offerPickIds.length > 0
    const hasRequestAssets = requestPlayerIds.length > 0 || requestPickIds.length > 0

    if (!hasOfferAssets || !hasRequestAssets) {
        throw new Error('A trade must include at least one asset on each side.')
    }

    const { data: trade, error: tradeError } = await (supabase as any)
        .from('trades')
        .insert({
            league_id: leagueId,
            league_season_id: seasonId,
            proposer_member_id: memberId,
            recipient_member_id: recipientMemberId,
            notes: notes ?? null,
            status: 'pending',
        })
        .select('id')
        .single()

    if (tradeError) throw tradeError

    const items: { trade_id: string; side: string; player_id: string | null; pick_id: string | null }[] = []

    for (const playerId of offerPlayerIds) {
        items.push({ trade_id: trade.id, side: 'proposer', player_id: playerId, pick_id: null })
    }

    for (const playerId of requestPlayerIds) {
        items.push({ trade_id: trade.id, side: 'recipient', player_id: playerId, pick_id: null })
    }

    for (const pickId of offerPickIds) {
        items.push({ trade_id: trade.id, side: 'proposer', player_id: null, pick_id: pickId })
    }

    for (const pickId of requestPickIds) {
        items.push({ trade_id: trade.id, side: 'recipient', player_id: null, pick_id: pickId })
    }

    if (items.length > 0) {
        const { error: itemsError } = await (supabase as any).from('trade_items').insert(items)
        if (itemsError) throw itemsError
    }

    // Notify recipient
    apiPost('/notify/trade', { memberId: recipientMemberId, title: 'New Trade Offer', body: 'You have a new trade offer waiting for your review.' }).catch(console.error)

    return trade.id
}

export async function acceptTrade(tradeId: string, memberId: string): Promise<void> {
    // Fetch the trade to verify recipient and get league info
    const { data: trade, error: fetchError } = await (supabase as any)
        .from('trades')
        .select('id, league_id, league_season_id, proposer_member_id, recipient_member_id, status')
        .eq('id', tradeId)
        .single()

    if (fetchError) throw fetchError
    if (!trade) throw new Error('Trade not found.')
    if ((trade as any).recipient_member_id !== memberId) throw new Error('You are not the recipient of this trade.')
    if ((trade as any).status !== 'pending') throw new Error('This trade is no longer pending.')

    // Fetch all trade items
    const { data: items, error: itemsError } = await (supabase as any)
        .from('trade_items')
        .select('id, side, player_id, pick_id')
        .eq('trade_id', tradeId)

    if (itemsError) throw itemsError

    const proposerItems = ((items ?? []) as any[]).filter((i) => i.side === 'proposer')
    const recipientItems = ((items ?? []) as any[]).filter((i) => i.side === 'recipient')

    const t = trade as any

    // Move proposer's players to recipient
    for (const item of proposerItems) {
        const i = item as any
        if (!i.player_id) continue
        const { error } = await (supabase as any)
            .from('roster_players')
            .update({ member_id: t.recipient_member_id, acquired_via: 'trade' })
            .eq('player_id', i.player_id)
            .eq('league_id', t.league_id)
            .eq('league_season_id', t.league_season_id)
        if (error) throw error
    }

    // Move recipient's players to proposer
    for (const item of recipientItems) {
        const i = item as any
        if (!i.player_id) continue
        const { error } = await (supabase as any)
            .from('roster_players')
            .update({ member_id: t.proposer_member_id, acquired_via: 'trade' })
            .eq('player_id', i.player_id)
            .eq('league_id', t.league_id)
            .eq('league_season_id', t.league_season_id)
        if (error) throw error
    }

    // Transfer proposer's picks to recipient
    for (const item of proposerItems) {
        const i = item as any
        if (!i.pick_id) continue
        const { error } = await (supabase as any)
            .from('draft_picks')
            .update({ current_owner_id: t.recipient_member_id })
            .eq('id', i.pick_id)
        if (error) throw error
    }

    // Transfer recipient's picks to proposer
    for (const item of recipientItems) {
        const i = item as any
        if (!i.pick_id) continue
        const { error } = await (supabase as any)
            .from('draft_picks')
            .update({ current_owner_id: t.proposer_member_id })
            .eq('id', i.pick_id)
        if (error) throw error
    }

    // Mark trade completed
    const { error: updateError } = await (supabase as any)
        .from('trades')
        .update({ status: 'completed', completed_at: new Date().toISOString(), accepted_at: new Date().toISOString() })
        .eq('id', tradeId)

    if (updateError) throw updateError

    // Notify proposer that their trade was accepted
    apiPost('/notify/trade', { memberId: t.proposer_member_id, title: 'Trade Accepted', body: 'Your trade offer has been accepted!' }).catch(console.error)

    // Log transactions for each player moved
    for (const item of proposerItems) {
        if (!item.player_id) continue
        await logTransaction({ leagueId: t.league_id, leagueSeasonId: t.league_season_id, memberId: t.proposer_member_id, playerId: item.player_id, transactionType: 'trade_out', relatedTradeId: tradeId })
        await logTransaction({ leagueId: t.league_id, leagueSeasonId: t.league_season_id, memberId: t.recipient_member_id, playerId: item.player_id, transactionType: 'trade_in', relatedTradeId: tradeId })
    }
    for (const item of recipientItems) {
        if (!item.player_id) continue
        await logTransaction({ leagueId: t.league_id, leagueSeasonId: t.league_season_id, memberId: t.recipient_member_id, playerId: item.player_id, transactionType: 'trade_out', relatedTradeId: tradeId })
        await logTransaction({ leagueId: t.league_id, leagueSeasonId: t.league_season_id, memberId: t.proposer_member_id, playerId: item.player_id, transactionType: 'trade_in', relatedTradeId: tradeId })
    }
}

export async function rejectTrade(tradeId: string, memberId: string): Promise<void> {
    const { data: trade, error: fetchError } = await (supabase as any)
        .from('trades')
        .select('id, recipient_member_id, status')
        .eq('id', tradeId)
        .single()

    if (fetchError) throw fetchError
    const t = trade as any
    if (!t) throw new Error('Trade not found.')
    if (t.recipient_member_id !== memberId) throw new Error('You are not the recipient of this trade.')
    if (t.status !== 'pending') throw new Error('This trade is no longer pending.')

    const { error } = await (supabase as any)
        .from('trades')
        .update({ status: 'rejected' })
        .eq('id', tradeId)

    if (error) throw error
    apiPost('/notify/trade', { memberId: t.proposer_member_id, title: 'Trade Rejected', body: 'Your trade offer was declined.' }).catch(console.error)
}

export async function withdrawTrade(tradeId: string, memberId: string): Promise<void> {
    const { data: trade, error: fetchError } = await (supabase as any)
        .from('trades')
        .select('id, proposer_member_id, status')
        .eq('id', tradeId)
        .single()

    if (fetchError) throw fetchError
    const t = trade as any
    if (!t) throw new Error('Trade not found.')
    if (t.proposer_member_id !== memberId) throw new Error('You are not the proposer of this trade.')
    if (t.status !== 'pending') throw new Error('This trade is no longer pending.')

    const { error } = await (supabase as any)
        .from('trades')
        .update({ status: 'withdrawn' })
        .eq('id', tradeId)

    if (error) throw error
    apiPost('/notify/trade', { memberId: t.recipient_member_id, title: 'Trade Withdrawn', body: 'A trade offer sent to you has been withdrawn.' }).catch(console.error)
}

export async function getMyTrades(memberId: string, leagueId: string): Promise<Trade[]> {
    const { data, error } = await (supabase as any)
        .from('trades')
        .select(
            `
            id,
            status,
            proposed_at,
            notes,
            proposer_member_id,
            recipient_member_id,
            proposer:league_members!trades_proposer_member_id_fkey ( team_name ),
            recipient:league_members!trades_recipient_member_id_fkey ( team_name ),
            trade_items (
                id,
                side,
                player_id,
                pick_id,
                players ( display_name, position, nba_team ),
                draft_picks (
                    season_year,
                    round,
                    original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
                )
            )
        `,
        )
        .or(`proposer_member_id.eq.${memberId},recipient_member_id.eq.${memberId}`)
        .eq('league_id', leagueId)
        .order('proposed_at', { ascending: false })
        .limit(20)

    if (error) throw error

    return (data ?? []).map((row: any) => {
        const proposerGives: TradeItem[] = []
        const recipientGives: TradeItem[] = []

        for (const item of row.trade_items ?? []) {
            let tradeItem: TradeItem | null = null

            if (item.player_id != null && item.players) {
                tradeItem = {
                    kind: 'player',
                    playerId: item.player_id,
                    playerName: item.players?.display_name ?? 'Unknown',
                    position: item.players?.position ?? null,
                    nbaTeam: item.players?.nba_team ?? null,
                } satisfies TradePlayerItem
            } else if (item.pick_id != null && item.draft_picks) {
                tradeItem = {
                    kind: 'pick',
                    pickId: item.pick_id,
                    seasonYear: item.draft_picks?.season_year,
                    round: item.draft_picks?.round,
                    originalTeamName: item.draft_picks?.original_owner?.team_name ?? 'Unknown',
                } satisfies TradePickItem
            }

            if (tradeItem) {
                if (item.side === 'proposer') {
                    proposerGives.push(tradeItem)
                } else {
                    recipientGives.push(tradeItem)
                }
            }
        }

        return {
            id: row.id,
            status: row.status,
            proposedAt: row.proposed_at,
            notes: row.notes ?? null,
            proposerMemberId: row.proposer_member_id,
            proposerTeamName: (row.proposer as any)?.team_name ?? 'Unknown',
            recipientMemberId: row.recipient_member_id,
            recipientTeamName: (row.recipient as any)?.team_name ?? 'Unknown',
            proposerGives,
            recipientGives,
        } satisfies Trade
    })
}

export { getCurrentSeasonId } from '@/lib/shared/season'
