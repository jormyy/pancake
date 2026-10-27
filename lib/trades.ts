import type { Json } from '@/types/database'
import { supabase } from '@/lib/supabase'
import { apiPost } from '@/lib/shared/api'
import { getRosterStatsMaps } from '@/lib/roster-stats'
import type { TradeStatus } from '@pancake/core'
import type { TradeEstimateSummary } from '@/lib/trade-estimates'
export {
    needsMemberAcceptance,
} from '@/lib/trade-perspective'

type TradeRosterMove = { playerId: string; destination: 'active' | 'ir' }
export type TradeRosterPlan = { taxiPlayerIds: string[]; irPlayerIds: string[]; dropPlayerIds: string[]; rosterMoves?: TradeRosterMove[] }
export type TradeRosterPreview = {
    memberId: string
    teamName: string
    roster: { playerId: string; name: string; location: 'active' | 'ir' | 'taxi' }[]
    drops: { playerId: string; name: string }[]
    moves: TradeRosterMove[]
    plan?: TradeRosterPlan
    unavailableMoves?: Record<string, string>
    unavailableDestinations?: Record<string, Partial<Record<'ir' | 'taxi', string>>>
    limits: { active: number; ir: number; taxi: number }
    error: string | null
}

export async function getTradeRosterPreview(tradeId: string): Promise<TradeRosterPreview[]> {
    const result = await apiPost<{ teams: TradeRosterPreview[] }>(`/trades/${tradeId}/roster-preview`, {})
    return result.teams
}

type TradePlayerItem = {
    kind: 'player'
    fromTaxi?: boolean
    toIR?: boolean
    toTaxi?: boolean
    playerId: string
    playerName: string
    position: string | null
    eligiblePositions?: string[]
    nbaTeam: string | null
    nbaId?: string | null
    injuryStatus?: string | null
    yearsExp?: number | null
    nbaDraftNumber?: number | null
    careerGames?: number | null
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
    dropPlayerIds?: string[]
    rosterMoves?: TradeRosterMove[]
    acceptedAt: string | null
}

export type Trade = {
    estimate?: TradeEstimateSummary | null
    estimateUnavailable?: string | null
    completionFailureReason?: string | null
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

export type TradePageCursor = {
    token: string
}

type TradeHistoryCursor = { proposedAt: string; tradeId: string }

export function tradeHistoryCursorToken(cursor: TradeHistoryCursor): string {
    return encodeURIComponent(JSON.stringify(cursor))
}

export function parseTradeHistoryCursor(cursor: TradePageCursor | null): TradeHistoryCursor | null {
    if (!cursor) return null
    try {
        const parsed = JSON.parse(decodeURIComponent(cursor.token)) as Partial<TradeHistoryCursor>
        if (typeof parsed.proposedAt !== 'string' || !Number.isFinite(Date.parse(parsed.proposedAt)) ||
            typeof parsed.tradeId !== 'string' || parsed.tradeId.length === 0) {
            throw new Error('invalid fields')
        }
        return { proposedAt: parsed.proposedAt, tradeId: parsed.tradeId }
    } catch {
        throw new Error('Trade history cursor is invalid.')
    }
}

export function tradeHistoryCursorFilter(cursor: TradeHistoryCursor): string {
    return `proposed_at.lt.${cursor.proposedAt},and(proposed_at.eq.${cursor.proposedAt},trade_id.lt.${cursor.tradeId})`
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
    nba_draft_number: number | null
    career_regular_season_games: number | null
    roster_players?: { league_season_id: string; member_id: string; is_on_taxi: boolean; is_on_ir?: boolean }[]
} | null
type TradeItemQueryRow = {
    to_ir: boolean
    to_taxi: boolean
    side: 'proposer' | 'recipient'
    player_id: string | null
    pick_id: string | null
    from_member_id: string
    to_member_id: string
    faab_amount: number | null
    players: TradePlayerQueryRow
    draft_picks: {
        season_year: number
        round: number
        original_owner: TeamNameRow
    } | null
}
function parseTradeRosterMoves(value: Json | undefined): TradeRosterMove[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((move) => move && typeof move === 'object' && !Array.isArray(move)
        && typeof move.playerId === 'string' && (move.destination === 'active' || move.destination === 'ir')
        ? [{ playerId: move.playerId, destination: move.destination }] : [])
}

type TradeParticipantQueryRow = {
    drop_player_ids: string[]
    roster_moves?: Json
    member_id: string
    sort_order: number
    is_initiator: boolean
    accepted_at: string | null
    league_members: TeamNameRow
}
type TradeQueryRow = {
    trade_estimates: { unavailable_reason: string | null; quote: {
        id: string; model_version: string; input_version: string; created_at: string; teams: TradeEstimateSummary['teams']
    } | null } | null
    completion_failure_reason: string | null
    id: string
    league_id: string
    league_season_id: string
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

type TradeProposalOptions = {
    estimateId?: string
    rosterPlan?: TradeRosterPlan
    requestId?: string
    notes?: string | null
    expiresAt?: string | null
    offerFaabAmount?: number
    requestFaabAmount?: number
}

export type TradeProposalPayload = {
    recipientMemberId?: string
    offerPlayerIds: string[]
    requestPlayerIds: string[]
    offerPickIds: string[]
    requestPickIds: string[]
} & TradeProposalOptions

type MultiTeamTradeRoute = {
    fromMemberId: string
    toMemberId: string
}

export type MultiTeamTradeItemPayload = MultiTeamTradeRoute & (
    | { kind: 'player'; playerId: string }
    | { kind: 'pick'; pickId: string }
    | { kind: 'faab'; faabAmount: number }
)

export type MultiTeamTradeProposalPayload = {
    participantMemberIds: string[]
    items: MultiTeamTradeItemPayload[]
} & Pick<TradeProposalOptions, 'notes' | 'expiresAt' | 'requestId' | 'rosterPlan' | 'estimateId'>

function multiTeamTradeWireItems(items: MultiTeamTradeItemPayload[]) {
    return items.map((item) => {
        const route = { fromMemberId: item.fromMemberId, toMemberId: item.toMemberId }
        if (item.kind === 'player') return { ...route, playerId: item.playerId }
        if (item.kind === 'pick') return { ...route, pickId: item.pickId }
        return { ...route, faabAmount: item.faabAmount }
    })
}

export type TradeBlockItem = {
    rosterLocation?: 'active' | 'ir' | 'taxi'
    id: string
    memberId: string
    teamName: string
    note: string | null
    updatedAt: string
    asset: Exclude<TradeItem, { kind: 'faab' }>
}

export async function getPicksForMembers(
    memberIds: string[],
    leagueId: string,
    options: { tradeableOnly?: boolean } = {},
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

    const unavailableSeasons = new Set<number>()
    if (options.tradeableOnly) {
        const { data: drafts, error: draftError } = await supabase.from('drafts')
            .select('league_seasons!inner(season_year)')
            .eq('league_id', leagueId).eq('draft_type', 'snake').eq('is_mock', false)
            .in('status', ['in_progress', 'paused'])
        if (draftError) throw draftError
        for (const draft of drafts ?? []) unavailableSeasons.add(draft.league_seasons.season_year)
    }
    for (const row of (data ?? []) as MemberTradePickQueryRow[]) {
        if (unavailableSeasons.has(row.season_year)) continue
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
        ...(options.estimateId ? { estimateId: options.estimateId } : {}),
        ...(options.rosterPlan ? { rosterPlan: options.rosterPlan } : {}),
        requestId: options.requestId,
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
        ...(payload.estimateId ? { estimateId: payload.estimateId } : {}),
        ...(payload.rosterPlan ? { rosterPlan: payload.rosterPlan } : {}),
        requestId: payload.requestId,
        memberId,
        leagueId,
        leagueSeasonId: seasonId,
        participantMemberIds: payload.participantMemberIds,
        items: multiTeamTradeWireItems(payload.items),
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
        ...(payload.estimateId ? { estimateId: payload.estimateId } : {}),
        ...(payload.rosterPlan ? { rosterPlan: payload.rosterPlan } : {}),
        requestId: payload.requestId,
        memberId,
        participantMemberIds: payload.participantMemberIds,
        items: multiTeamTradeWireItems(payload.items),
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
        ...(payload.estimateId ? { estimateId: payload.estimateId } : {}),
        ...(payload.rosterPlan ? { rosterPlan: payload.rosterPlan } : {}),
        requestId: payload.requestId,
        memberId,
        participantMemberIds: payload.participantMemberIds,
        items: multiTeamTradeWireItems(payload.items),
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

export async function setTradeRosterPlan(tradeId: string, memberId: string, plan: TradeRosterPlan) {
    const result = await apiPost<{ rosterPlan: TradeRosterPlan }>(`/trades/${tradeId}/roster-plan`, { memberId, ...plan })
    return result.rosterPlan
}

export async function setTradeTaxiDestinations(tradeId: string, memberId: string, playerIds: string[]) {
    await apiPost(`/trades/${tradeId}/taxi-destinations`, { memberId, playerIds })
}

export async function acceptTrade(
    tradeId: string,
    memberId: string,
    rosterPlan?: TradeRosterPlan,
): Promise<void> {
    await apiPost(`/trades/${tradeId}/accept`, { memberId, ...(rosterPlan ? { rosterPlan } : {}) })
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
            league_season_id,
            status,
            completion_failure_reason,
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
            trade_estimates ( unavailable_reason, quote:trade_estimate_quotes ( id, model_version, input_version, created_at, teams:analysis->teams ) ),
            proposer:league_members!trades_proposer_member_id_fkey ( team_name ),
            recipient:league_members!trades_recipient_member_id_fkey ( team_name ),
            trade_vetos ( member_id ),
            trade_participants (
                member_id,
                sort_order,
                is_initiator,
                accepted_at, drop_player_ids, roster_moves,
                league_members ( team_name )
            ),
            trade_items (
                id,
                side,
                player_id,
                to_taxi, to_ir,
                pick_id,
                from_member_id,
                to_member_id,
                faab_amount,
                players ( display_name, position, eligible_positions, nba_team, nba_id, injury_status, years_exp, nba_draft_number, career_regular_season_games, roster_players ( league_season_id, member_id, is_on_taxi ) ),
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
        const fromMemberId = item.from_member_id
        const toMemberId = item.to_member_id
        let tradeItem: RoutedTradeItem | null = null

        if (item.player_id != null && item.players) {
            tradeItem = {
                kind: 'player',
                fromTaxi: item.players.roster_players?.some((roster) => roster.league_season_id === row.league_season_id && roster.member_id === fromMemberId && roster.is_on_taxi) ?? false,
                toTaxi: item.to_taxi,
                toIR: item.to_ir,
                playerId: item.player_id,
                playerName: item.players?.display_name ?? 'Unknown',
                position: item.players?.position ?? null,
                eligiblePositions: item.players?.eligible_positions ?? (item.players?.position ? [item.players.position] : []),
                nbaTeam: item.players?.nba_team ?? null,
                nbaId: item.players?.nba_id ?? null,
                injuryStatus: item.players?.injury_status ?? null,
                yearsExp: item.players?.years_exp ?? null,
                nbaDraftNumber: item.players?.nba_draft_number ?? null,
                careerGames: item.players?.career_regular_season_games ?? null,
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
            dropPlayerIds: participant.drop_player_ids ?? [],
            rosterMoves: parseTradeRosterMoves(participant.roster_moves),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.teamName.localeCompare(b.teamName))

    return {
        estimate: row.trade_estimates?.quote ? {
            quoteId: row.trade_estimates.quote.id,
            modelVersion: row.trade_estimates.quote.model_version,
            inputVersion: row.trade_estimates.quote.input_version,
            createdAt: row.trade_estimates.quote.created_at,
            teams: row.trade_estimates.quote.teams,
        } : null,
        estimateUnavailable: row.trade_estimates?.unavailable_reason ?? null,
        id: row.id,
        status: row.status,
        completionFailureReason: row.completion_failure_reason,
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
    const playerIds = [...new Set(trades.flatMap((trade) => playerIdsFromItems(trade.routedItems)))]
    if (playerIds.length === 0) return trades

    let avgMap: Map<string, number>
    let avgStatsMap: Map<string, { avg_minutes_played: number | null }>
    try {
        const stats = await getRosterStatsMaps(playerIds, leagueId)
        avgMap = stats.avgMap
        avgStatsMap = stats.avgStatsMap
    } catch (error) {
        console.warn('Could not load optional trade player averages.', error)
        return trades
    }
    return trades.map((trade) => {
        const routedItems = enrichItemsWithStats(trade.routedItems, avgMap, avgStatsMap)
        return {
            ...trade,
            routedItems,
        }
    })
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

/** Attaches season averages to listed players; the caller loads the averages once for listings and roster together. */
export function withTradeBlockStats(
    items: TradeBlockItem[],
    avgMap: Map<string, number>,
    avgStatsMap: Map<string, { avg_minutes_played: number | null }>,
): TradeBlockItem[] {
    if (avgMap.size === 0 && avgStatsMap.size === 0) return items
    return items.map((item) => item.asset.kind === 'player'
        ? { ...item, asset: enrichItemsWithStats([item.asset], avgMap, avgStatsMap)[0] }
        : item)
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
