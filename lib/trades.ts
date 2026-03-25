import { supabase } from '@/lib/supabase'

export type TradeItem = {
    playerId: string
    playerName: string
    position: string | null
    nbaTeam: string | null
}

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

async function getCurrentSeasonId(leagueId: string): Promise<string | null> {
    const { data } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    return data?.id ?? null
}

export async function proposeTrade(
    memberId: string,
    leagueId: string,
    seasonId: string,
    recipientMemberId: string,
    offerPlayerIds: string[],
    requestPlayerIds: string[],
    notes?: string,
): Promise<string> {
    if (offerPlayerIds.length === 0 && requestPlayerIds.length === 0) {
        throw new Error('A trade must include at least one player on each side.')
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

    const items: { trade_id: string; side: string; player_id: string }[] = []

    for (const playerId of offerPlayerIds) {
        items.push({ trade_id: trade.id, side: 'proposer', player_id: playerId })
    }

    for (const playerId of requestPlayerIds) {
        items.push({ trade_id: trade.id, side: 'recipient', player_id: playerId })
    }

    if (items.length > 0) {
        const { error: itemsError } = await (supabase as any).from('trade_items').insert(items)
        if (itemsError) throw itemsError
    }

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
        .select('id, side, player_id')
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

    // Mark trade completed
    const { error: updateError } = await (supabase as any)
        .from('trades')
        .update({ status: 'completed', completed_at: new Date().toISOString(), accepted_at: new Date().toISOString() })
        .eq('id', tradeId)

    if (updateError) throw updateError
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
                players ( display_name, position, nba_team )
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
            if (!item.player_id) continue
            const tradeItem: TradeItem = {
                playerId: item.player_id,
                playerName: item.players?.display_name ?? 'Unknown',
                position: item.players?.position ?? null,
                nbaTeam: item.players?.nba_team ?? null,
            }
            if (item.side === 'proposer') {
                proposerGives.push(tradeItem)
            } else {
                recipientGives.push(tradeItem)
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

export { getCurrentSeasonId }
