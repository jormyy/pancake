import { supabase } from '@/lib/supabase'
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
    const { data, error } = await supabase
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
    const result = await apiPost<{ tradeId: string }>('/trades/propose', {
        memberId,
        leagueId,
        leagueSeasonId: seasonId,
        recipientMemberId,
        offerPlayerIds,
        requestPlayerIds,
        offerPickIds,
        requestPickIds,
        notes: notes ?? '',
    })

    return result.tradeId
}

export async function acceptTrade(tradeId: string, memberId: string): Promise<void> {
    await apiPost(`/trades/${tradeId}/accept`, { memberId })
}

export async function rejectTrade(tradeId: string, memberId: string): Promise<void> {
    const { data: trade, error: fetchError } = await supabase
        .from('trades')
        .select('id, proposer_member_id, recipient_member_id, status')
        .eq('id', tradeId)
        .single()

    if (fetchError) throw fetchError
    const t = trade
    if (!t) throw new Error('Trade not found.')
    if (t.recipient_member_id !== memberId) throw new Error('You are not the recipient of this trade.')
    if (t.status !== 'pending') throw new Error('This trade is no longer pending.')

    const { error } = await supabase
        .from('trades')
        .update({ status: 'rejected' })
        .eq('id', tradeId)

    if (error) throw error
    apiPost('/notify/trade', { memberId: t.proposer_member_id, title: 'Trade Rejected', body: 'Your trade offer was declined.' }).catch(console.error)
}

export async function withdrawTrade(tradeId: string, memberId: string): Promise<void> {
    const { data: trade, error: fetchError } = await supabase
        .from('trades')
        .select('id, proposer_member_id, recipient_member_id, status')
        .eq('id', tradeId)
        .single()

    if (fetchError) throw fetchError
    const t = trade
    if (!t) throw new Error('Trade not found.')
    if (t.proposer_member_id !== memberId) throw new Error('You are not the proposer of this trade.')
    if (t.status !== 'pending') throw new Error('This trade is no longer pending.')

    const { error } = await supabase
        .from('trades')
        .update({ status: 'withdrawn' })
        .eq('id', tradeId)

    if (error) throw error
    apiPost('/notify/trade', { memberId: t.recipient_member_id, title: 'Trade Withdrawn', body: 'A trade offer sent to you has been withdrawn.' }).catch(console.error)
}

export async function getMyTrades(memberId: string, leagueId: string): Promise<Trade[]> {
    const { data, error } = await supabase
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
            proposerTeamName: row.proposer?.team_name ?? 'Unknown',
            recipientMemberId: row.recipient_member_id,
            recipientTeamName: row.recipient?.team_name ?? 'Unknown',
            proposerGives,
            recipientGives,
        } satisfies Trade
    })
}

export { getCurrentSeasonId } from '@/lib/shared/season'
