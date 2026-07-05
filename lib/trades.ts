import { supabase } from '@/lib/supabase'
import { apiPost } from '@/lib/shared/api'

export type TradePlayerItem = {
    kind: 'player'
    playerId: string
    playerName: string
    position: string | null
    nbaTeam: string | null
    nbaId?: string | null
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
    acceptedAt: string | null
    vetoWindowExpiresAt: string | null
    completedAt: string | null
    vetoedAt: string | null
    expiresAt: string | null
    notes: string | null
    proposerMemberId: string
    proposerTeamName: string
    recipientMemberId: string
    recipientTeamName: string
    parentTradeId: string | null
    counteredFromTradeId: string | null
    editedFromTradeId: string | null
    replacedByTradeId: string | null
    version: number
    proposerFaabAmount: number
    recipientFaabAmount: number
    myVetoed: boolean
    // Items the proposer is giving (recipient receives)
    proposerGives: TradeItem[]
    // Items the recipient is giving (proposer receives)
    recipientGives: TradeItem[]
}

type TeamNameRow = { team_name: string | null } | null
type TradePickQueryRow = {
    id: string
    season_year: number
    round: number
    original_owner: TeamNameRow
}
type TradePlayerQueryRow = {
    display_name: string | null
    position: string | null
    nba_team: string | null
    nba_id: string | null
} | null
type TradeItemQueryRow = {
    side: 'proposer' | 'recipient'
    player_id: string | null
    pick_id: string | null
    players: TradePlayerQueryRow
    draft_picks: {
        season_year: number
        round: number
        original_owner: TeamNameRow
    } | null
}
type TradeQueryRow = {
    id: string
    status: string
    proposed_at: string
    accepted_at: string | null
    veto_window_expires_at: string | null
    completed_at: string | null
    vetoed_at: string | null
    expires_at: string | null
    notes: string | null
    proposer_member_id: string
    recipient_member_id: string
    parent_trade_id: string | null
    countered_from_trade_id: string | null
    edited_from_trade_id: string | null
    replaced_by_trade_id: string | null
    version: number
    proposer_faab_amount: number
    recipient_faab_amount: number
    proposer: TeamNameRow
    recipient: TeamNameRow
    trade_vetos: { member_id: string | null }[] | null
    trade_items: TradeItemQueryRow[] | null
}

export type TradeProposalOptions = {
    notes?: string | null
    expiresAt?: string | null
    offerFaabAmount?: number
    requestFaabAmount?: number
}

export type TradeProposalPayload = {
    offerPlayerIds: string[]
    requestPlayerIds: string[]
    offerPickIds: string[]
    requestPickIds: string[]
} & TradeProposalOptions

export type TradeBlockItem = {
    id: string
    memberId: string
    teamName: string
    note: string | null
    updatedAt: string
    asset: TradeItem
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

    return ((data ?? []) as TradePickQueryRow[]).map((row) => ({
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
    options: Omit<TradeProposalOptions, 'notes'> = {},
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
        expiresAt: options.expiresAt ?? null,
        offerFaabAmount: options.offerFaabAmount ?? 0,
        requestFaabAmount: options.requestFaabAmount ?? 0,
    })

    return result.tradeId
}

export async function counterTrade(
    tradeId: string,
    memberId: string,
    payload: TradeProposalPayload,
): Promise<string> {
    const result = await apiPost<{ tradeId: string }>(`/trades/${tradeId}/counter`, {
        memberId,
        ...payload,
        notes: payload.notes ?? '',
        expiresAt: payload.expiresAt ?? null,
        offerFaabAmount: payload.offerFaabAmount ?? 0,
        requestFaabAmount: payload.requestFaabAmount ?? 0,
    })
    return result.tradeId
}

export async function editTrade(
    tradeId: string,
    memberId: string,
    payload: TradeProposalPayload,
): Promise<string> {
    const result = await apiPost<{ tradeId: string }>(`/trades/${tradeId}/edit`, {
        memberId,
        ...payload,
        notes: payload.notes ?? '',
        expiresAt: payload.expiresAt ?? null,
        offerFaabAmount: payload.offerFaabAmount ?? 0,
        requestFaabAmount: payload.requestFaabAmount ?? 0,
    })
    return result.tradeId
}

export async function acceptTrade(
    tradeId: string,
    memberId: string,
    dropRosterPlayerIds: string[] = [],
): Promise<void> {
    await apiPost(`/trades/${tradeId}/accept`, { memberId, dropRosterPlayerIds })
}

export async function rejectTrade(tradeId: string, memberId: string): Promise<void> {
    await apiPost(`/trades/${tradeId}/reject`, { memberId })
}

export async function withdrawTrade(tradeId: string, memberId: string): Promise<void> {
    await apiPost(`/trades/${tradeId}/withdraw`, { memberId })
}

export async function vetoTrade(tradeId: string, memberId: string): Promise<void> {
    await apiPost(`/trades/${tradeId}/veto`, { memberId })
}

const TRADE_SELECT = `
            id,
            status,
            proposed_at,
            accepted_at,
            veto_window_expires_at,
            completed_at,
            vetoed_at,
            expires_at,
            notes,
            proposer_member_id,
            recipient_member_id,
            parent_trade_id,
            countered_from_trade_id,
            edited_from_trade_id,
            replaced_by_trade_id,
            version,
            proposer_faab_amount,
            recipient_faab_amount,
            proposer:league_members!trades_proposer_member_id_fkey ( team_name ),
            recipient:league_members!trades_recipient_member_id_fkey ( team_name ),
            trade_vetos ( member_id ),
            trade_items (
                id,
                side,
                player_id,
                pick_id,
                players ( display_name, position, nba_team, nba_id ),
                draft_picks (
                    season_year,
                    round,
                    original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
                )
            )
        `

function mapTradeRow(row: TradeQueryRow, memberId: string): Trade {
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
                nbaId: item.players?.nba_id ?? null,
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
        acceptedAt: row.accepted_at ?? null,
        vetoWindowExpiresAt: row.veto_window_expires_at ?? null,
        completedAt: row.completed_at ?? null,
        vetoedAt: row.vetoed_at ?? null,
        expiresAt: row.expires_at ?? null,
        notes: row.notes ?? null,
        proposerMemberId: row.proposer_member_id,
        proposerTeamName: row.proposer?.team_name ?? 'Unknown',
        recipientMemberId: row.recipient_member_id,
        recipientTeamName: row.recipient?.team_name ?? 'Unknown',
        parentTradeId: row.parent_trade_id ?? null,
        counteredFromTradeId: row.countered_from_trade_id ?? null,
        editedFromTradeId: row.edited_from_trade_id ?? null,
        replacedByTradeId: row.replaced_by_trade_id ?? null,
        version: row.version ?? 1,
        proposerFaabAmount: row.proposer_faab_amount ?? 0,
        recipientFaabAmount: row.recipient_faab_amount ?? 0,
        myVetoed: (row.trade_vetos ?? []).some((veto: { member_id: string | null }) => veto.member_id === memberId),
        proposerGives,
        recipientGives,
    } satisfies Trade
}

export async function getMyTrades(memberId: string, leagueId: string): Promise<Trade[]> {
    const { data, error } = await supabase
        .from('trades')
        .select(TRADE_SELECT)
        .or(`proposer_member_id.eq.${memberId},recipient_member_id.eq.${memberId}`)
        .eq('league_id', leagueId)
        .order('proposed_at', { ascending: false })
        .limit(20)

    if (error) throw error

    return ((data ?? []) as TradeQueryRow[]).map((row) => mapTradeRow(row, memberId))
}

export async function getVetoableTrades(memberId: string, leagueId: string): Promise<Trade[]> {
    const { data, error } = await supabase
        .from('trades')
        .select(TRADE_SELECT)
        .eq('league_id', leagueId)
        .eq('status', 'accepted')
        .neq('proposer_member_id', memberId)
        .neq('recipient_member_id', memberId)
        .gt('veto_window_expires_at', new Date().toISOString())
        .order('accepted_at', { ascending: false })
        .limit(20)

    if (error) throw error

    return ((data ?? []) as TradeQueryRow[]).map((row) => mapTradeRow(row, memberId))
}

export async function getTradeById(tradeId: string, memberId: string): Promise<Trade | null> {
    const { data, error } = await supabase
        .from('trades')
        .select(TRADE_SELECT)
        .eq('id', tradeId)
        .maybeSingle()

    if (error) throw error
    return data ? mapTradeRow(data as TradeQueryRow, memberId) : null
}

type TradeBlockQueryRow = {
    id: string
    member_id: string
    player_id: string | null
    pick_id: string | null
    note: string | null
    updated_at: string
    league_members: TeamNameRow
    players: TradePlayerQueryRow
    draft_picks: {
        season_year: number
        round: number
        original_owner: TeamNameRow
    } | null
}

export async function getTradeBlockItems(leagueId: string): Promise<TradeBlockItem[]> {
    const { data, error } = await supabase
        .from('trade_block_items')
        .select(`
            id,
            member_id,
            player_id,
            pick_id,
            note,
            updated_at,
            league_members ( team_name ),
            players ( display_name, position, nba_team, nba_id ),
            draft_picks (
                season_year,
                round,
                original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
            )
        `)
        .eq('league_id', leagueId)
        .order('updated_at', { ascending: false })

    if (error) throw error

    return ((data ?? []) as TradeBlockQueryRow[]).flatMap<TradeBlockItem>((row) => {
        if (row.player_id && row.players) {
            return [{
                id: row.id,
                memberId: row.member_id,
                teamName: row.league_members?.team_name ?? 'Unknown',
                note: row.note ?? null,
                updatedAt: row.updated_at,
                asset: {
                    kind: 'player' as const,
                    playerId: row.player_id,
                    playerName: row.players.display_name ?? 'Unknown',
                    position: row.players.position ?? null,
                    nbaTeam: row.players.nba_team ?? null,
                    nbaId: row.players.nba_id ?? null,
                },
            }]
        }
        if (row.pick_id && row.draft_picks) {
            return [{
                id: row.id,
                memberId: row.member_id,
                teamName: row.league_members?.team_name ?? 'Unknown',
                note: row.note ?? null,
                updatedAt: row.updated_at,
                asset: {
                    kind: 'pick' as const,
                    pickId: row.pick_id,
                    seasonYear: row.draft_picks.season_year,
                    round: row.draft_picks.round,
                    originalTeamName: row.draft_picks.original_owner?.team_name ?? 'Unknown',
                },
            }]
        }
        return []
    })
}

export async function addTradeBlockItem(params: {
    memberId: string
    leagueId: string
    playerId?: string | null
    pickId?: string | null
    note?: string | null
}): Promise<string> {
    const result = await apiPost<{ tradeBlockItemId: string }>('/trades/block', {
        memberId: params.memberId,
        leagueId: params.leagueId,
        playerId: params.playerId ?? null,
        pickId: params.pickId ?? null,
        note: params.note ?? null,
    })
    return result.tradeBlockItemId
}

export async function removeTradeBlockItem(itemId: string, memberId: string): Promise<void> {
    await apiPost(`/trades/block/${itemId}/remove`, { memberId })
}

export { getCurrentSeasonId } from '@/lib/shared/season'
