import { supabase } from '@/lib/supabase'
import { apiPost } from '@/lib/shared/api'
import { getRosterStatsMaps } from '@/lib/roster-stats'
import type { TradeStatus } from '@pancake/core'
export {
    isIncomingTradeForMember,
    isOutgoingTradeForMember,
    isTradeHistoryForMember,
    isVetoableTradeForMember,
    needsMemberAcceptance,
} from '@/lib/trade-perspective'

type TradePlayerItem = {
    kind: 'player'
    playerId: string
    playerName: string
    position: string | null
    eligiblePositions?: string[]
    nbaTeam: string | null
    nbaId?: string | null
    injuryStatus?: string | null
    yearsExp?: number | null
    avgFantasyPoints?: number | null
    avgMinutesPlayed?: number | null
    fromMemberId?: string | null
    toMemberId?: string | null
}

export type TradePickItem = {
    kind: 'pick'
    pickId: string
    seasonYear: number
    round: number
    originalTeamName: string
    fromMemberId?: string | null
    toMemberId?: string | null
}

type TradeFaabItem = {
    kind: 'faab'
    amount: number
    fromMemberId?: string | null
    toMemberId?: string | null
}

export type TradeItem = TradePlayerItem | TradePickItem | TradeFaabItem
export type RoutedTradeItem = TradeItem & { fromMemberId: string; toMemberId: string }

type TradeParticipant = {
    memberId: string
    teamName: string
    sortOrder: number
    isInitiator: boolean
    acceptedAt: string | null
}

export type Trade = {
    id: string
    status: TradeStatus
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
    isMultiTeam: boolean
    participants: TradeParticipant[]
    parentTradeId: string | null
    counteredFromTradeId: string | null
    editedFromTradeId: string | null
    replacedByTradeId: string | null
    version: number
    proposerFaabAmount: number
    recipientFaabAmount: number
    myVetoed: boolean
    routedItems: RoutedTradeItem[]
}

type TeamNameRow = { team_name: string | null } | null
type TradePickQueryRow = {
    id: string
    season_year: number
    round: number
    original_owner: TeamNameRow
}
type MemberTradePickQueryRow = TradePickQueryRow & { current_owner_id: string }
type TradePlayerQueryRow = {
    display_name: string | null
    position: string | null
    eligible_positions: string[] | null
    nba_team: string | null
    nba_id: string | null
    injury_status: string | null
    years_exp: number | null
} | null
type TradeItemQueryRow = {
    side: 'proposer' | 'recipient'
    player_id: string | null
    pick_id: string | null
    from_member_id: string | null
    to_member_id: string | null
    faab_amount: number | null
    players: TradePlayerQueryRow
    draft_picks: {
        season_year: number
        round: number
        original_owner: TeamNameRow
    } | null
}
type TradeParticipantQueryRow = {
    member_id: string
    sort_order: number
    is_initiator: boolean
    accepted_at: string | null
    league_members: TeamNameRow
}
type TradeQueryRow = {
    id: string
    league_id: string
    status: TradeStatus
    proposed_at: string
    accepted_at: string | null
    veto_window_expires_at: string | null
    completed_at: string | null
    vetoed_at: string | null
    expires_at: string | null
    notes: string | null
    proposer_member_id: string
    recipient_member_id: string
    is_multi_team: boolean | null
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
    trade_participants: TradeParticipantQueryRow[] | null
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

export type MultiTeamTradeItemPayload = {
    fromMemberId: string
    toMemberId: string
    playerId?: string | null
    pickId?: string | null
    faabAmount?: number
}

export type MultiTeamTradeProposalPayload = {
    participantMemberIds: string[]
    items: MultiTeamTradeItemPayload[]
} & Pick<TradeProposalOptions, 'notes' | 'expiresAt'>

export type TradeBlockItem = {
    id: string
    memberId: string
    teamName: string
    note: string | null
    updatedAt: string
    asset: TradeItem
}

export async function getPicksForMember(memberId: string, leagueId: string): Promise<TradePickItem[]> {
    const picks = await getPicksForMembers([memberId], leagueId)
    return picks[memberId] ?? []
}

export async function getPicksForMembers(
    memberIds: string[],
    leagueId: string,
): Promise<Record<string, TradePickItem[]>> {
    const uniqueMemberIds = [...new Set(memberIds)]
    const picks = Object.fromEntries(uniqueMemberIds.map((memberId) => [memberId, [] as TradePickItem[]]))
    if (uniqueMemberIds.length === 0) return picks
    const { data, error } = await supabase
        .from('draft_picks')
        .select(`
            id,
            current_owner_id,
            season_year,
            round,
            original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
        `)
        .in('current_owner_id', uniqueMemberIds)
        .eq('league_id', leagueId)
        .eq('is_used', false)
        .order('season_year', { ascending: true })
        .order('round', { ascending: true })

    if (error) throw error

    for (const row of (data ?? []) as MemberTradePickQueryRow[]) {
        picks[row.current_owner_id]?.push({
            kind: 'pick',
            pickId: row.id,
            seasonYear: row.season_year,
            round: row.round,
            originalTeamName: row.original_owner?.team_name ?? 'Unknown',
        })
    }
    return picks
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

export async function proposeMultiTeamTrade(
    memberId: string,
    leagueId: string,
    seasonId: string,
    payload: MultiTeamTradeProposalPayload,
): Promise<string> {
    const result = await apiPost<{ tradeId: string }>('/trades/propose-multi', {
        memberId,
        leagueId,
        leagueSeasonId: seasonId,
        participantMemberIds: payload.participantMemberIds,
        items: payload.items,
        notes: payload.notes ?? '',
        expiresAt: payload.expiresAt ?? null,
    })

    return result.tradeId
}

export async function counterMultiTeamTrade(
    tradeId: string,
    memberId: string,
    payload: MultiTeamTradeProposalPayload,
): Promise<string> {
    const result = await apiPost<{ tradeId: string }>(`/trades/${tradeId}/counter-multi`, {
        memberId,
        participantMemberIds: payload.participantMemberIds,
        items: payload.items,
        notes: payload.notes ?? '',
        expiresAt: payload.expiresAt ?? null,
    })

    return result.tradeId
}

export async function editMultiTeamTrade(
    tradeId: string,
    memberId: string,
    payload: MultiTeamTradeProposalPayload,
): Promise<string> {
    const result = await apiPost<{ tradeId: string }>(`/trades/${tradeId}/edit-multi`, {
        memberId,
        participantMemberIds: payload.participantMemberIds,
        items: payload.items,
        notes: payload.notes ?? '',
        expiresAt: payload.expiresAt ?? null,
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
            league_id,
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
            is_multi_team,
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
            trade_participants (
                member_id,
                sort_order,
                is_initiator,
                accepted_at,
                league_members ( team_name )
            ),
            trade_items (
                id,
                side,
                player_id,
                pick_id,
                from_member_id,
                to_member_id,
                faab_amount,
                players ( display_name, position, eligible_positions, nba_team, nba_id, injury_status, years_exp ),
                draft_picks (
                    season_year,
                    round,
                    original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
                )
            )
        `

function mapTradeRow(row: TradeQueryRow, memberId: string): Trade {
    const routedItems: RoutedTradeItem[] = []

    for (const item of row.trade_items ?? []) {
        const fromMemberId = item.from_member_id ?? (item.side === 'proposer' ? row.proposer_member_id : row.recipient_member_id)
        const toMemberId = item.to_member_id ?? (fromMemberId === row.proposer_member_id
            ? row.recipient_member_id
            : row.proposer_member_id)
        let tradeItem: RoutedTradeItem | null = null

        if (item.player_id != null && item.players) {
            tradeItem = {
                kind: 'player',
                playerId: item.player_id,
                playerName: item.players?.display_name ?? 'Unknown',
                position: item.players?.position ?? null,
                eligiblePositions: item.players?.eligible_positions ?? (item.players?.position ? [item.players.position] : []),
                nbaTeam: item.players?.nba_team ?? null,
                nbaId: item.players?.nba_id ?? null,
                injuryStatus: item.players?.injury_status ?? null,
                yearsExp: item.players?.years_exp ?? null,
                fromMemberId,
                toMemberId,
            } satisfies RoutedTradeItem
        } else if (item.pick_id != null && item.draft_picks) {
            tradeItem = {
                kind: 'pick',
                pickId: item.pick_id,
                seasonYear: item.draft_picks?.season_year,
                round: item.draft_picks?.round,
                originalTeamName: item.draft_picks?.original_owner?.team_name ?? 'Unknown',
                fromMemberId,
                toMemberId,
            } satisfies RoutedTradeItem
        } else if ((item.faab_amount ?? 0) > 0) {
            tradeItem = {
                kind: 'faab',
                amount: item.faab_amount ?? 0,
                fromMemberId,
                toMemberId,
            } satisfies RoutedTradeItem
        }

        if (tradeItem) {
            routedItems.push(tradeItem)
        }
    }
    const participants = (row.trade_participants ?? [])
        .map((participant) => ({
            memberId: participant.member_id,
            teamName: participant.league_members?.team_name ?? 'Unknown',
            sortOrder: participant.sort_order ?? 0,
            isInitiator: participant.is_initiator ?? false,
            acceptedAt: participant.accepted_at ?? null,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.teamName.localeCompare(b.teamName))

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
        isMultiTeam: row.is_multi_team ?? false,
        participants,
        parentTradeId: row.parent_trade_id ?? null,
        counteredFromTradeId: row.countered_from_trade_id ?? null,
        editedFromTradeId: row.edited_from_trade_id ?? null,
        replacedByTradeId: row.replaced_by_trade_id ?? null,
        version: row.version ?? 1,
        proposerFaabAmount: row.proposer_faab_amount ?? 0,
        recipientFaabAmount: row.recipient_faab_amount ?? 0,
        myVetoed: (row.trade_vetos ?? []).some((veto: { member_id: string | null }) => veto.member_id === memberId),
        routedItems,
    } satisfies Trade
}

function playerIdsFromItems(items: TradeItem[]): string[] {
    return items.flatMap((item) => item.kind === 'player' ? [item.playerId] : [])
}

function enrichItemsWithStats<Item extends TradeItem>(
    items: Item[],
    avgMap: Map<string, number>,
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>,
): Item[] {
    return items.map((item) => {
        if (item.kind !== 'player') return item
        return {
            ...item,
            avgFantasyPoints: avgMap.get(item.playerId) ?? null,
            avgMinutesPlayed: avgStatsMap.get(item.playerId)?.avg_minutes_played ?? null,
        } as Item
    })
}

async function enrichTradesWithStats(trades: Trade[], leagueId: string): Promise<Trade[]> {
    const playerIds = trades.flatMap((trade) => playerIdsFromItems(trade.routedItems))
    if (playerIds.length === 0) return trades

    const { avgMap, avgStatsMap } = await getRosterStatsMaps(playerIds, leagueId)
    return trades.map((trade) => {
        const routedItems = enrichItemsWithStats(trade.routedItems, avgMap, avgStatsMap)
        return {
            ...trade,
            routedItems,
        }
    })
}

export async function getTradesForScreen(
    memberId: string,
    leagueId: string,
    limit = 40,
    offset = 0,
): Promise<Trade[]> {
    const { data, error } = await supabase
        .rpc('get_trades_for_member', {
            p_member_id: memberId,
            p_league_id: leagueId,
            p_limit: limit,
            p_offset: offset,
        })
        .select(TRADE_SELECT)
        .overrideTypes<TradeQueryRow[]>()

    if (error) throw error

    const visible = (data ?? [])
        .map((row) => mapTradeRow(row, memberId))
        .filter((trade) => isTradeVisibleOnScreen(trade, memberId))

    return enrichTradesWithStats(visible, leagueId)
}

export function isTradeVisibleOnScreen(trade: Trade, memberId: string, nowMs = Date.now()): boolean {
    const isParticipant = trade.proposerMemberId === memberId ||
        trade.recipientMemberId === memberId ||
        trade.participants.some((participant) => participant.memberId === memberId)
    if (isParticipant) return true
    return trade.status === 'accepted' &&
        trade.vetoWindowExpiresAt != null &&
        Date.parse(trade.vetoWindowExpiresAt) > nowMs
}

export async function getPendingIncomingTradeCount(memberId: string, leagueId: string): Promise<number> {
    const { data, error } = await supabase.rpc('get_pending_trade_count', {
        p_member_id: memberId,
        p_league_id: leagueId,
    })

    if (error) throw error
    return data ?? 0
}

export async function getTradeById(tradeId: string, memberId: string): Promise<Trade | null> {
    const { data, error } = await supabase
        .from('trades')
        .select(TRADE_SELECT)
        .eq('id', tradeId)
        .maybeSingle()

    if (error) throw error
    if (!data) return null
    const row = data as TradeQueryRow
    const [trade] = await enrichTradesWithStats([mapTradeRow(row, memberId)], row.league_id)
    return trade ?? null
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
            players ( display_name, position, eligible_positions, nba_team, nba_id, injury_status, years_exp ),
            draft_picks (
                season_year,
                round,
                original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
            )
        `)
        .eq('league_id', leagueId)
        .order('updated_at', { ascending: false })

    if (error) throw error

    const items = ((data ?? []) as TradeBlockQueryRow[]).flatMap<TradeBlockItem>((row) => {
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
                    eligiblePositions: row.players.eligible_positions ?? (row.players.position ? [row.players.position] : []),
                    nbaTeam: row.players.nba_team ?? null,
                    nbaId: row.players.nba_id ?? null,
                    injuryStatus: row.players.injury_status ?? null,
                    yearsExp: row.players.years_exp ?? null,
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

    const playerIds = items.flatMap((item) => item.asset.kind === 'player' ? [item.asset.playerId] : [])
    if (playerIds.length === 0) return items
    const { avgMap, avgStatsMap } = await getRosterStatsMaps(playerIds, leagueId)
    return items.map((item) => ({
        ...item,
        asset: item.asset.kind === 'player'
            ? enrichItemsWithStats([item.asset], avgMap, avgStatsMap)[0]
            : item.asset,
    }))
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
