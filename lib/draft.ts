import { supabase } from '@/lib/supabase'
import { RealtimeChannel } from '@supabase/supabase-js'
import { apiPost as sharedApiPost } from '@/lib/shared/api'

export type DraftOrderEntry = {
    position: number
    memberId: string
    teamName: string
}

export type DraftBudget = {
    memberId: string
    teamName: string
    remaining: number
    initialBudget: number
}

export type Nomination = {
    id: string
    status: 'open' | 'sold' | 'no_bid' | 'withdrawn'
    nominatingMemberId: string
    currentBidAmount: number
    currentBidderId: string | null
    countdownExpiresAt: string | null
    winningMemberId: string | null
    finalPrice: number | null
    nominatedAt: string
    nominationOrder: number
    player: {
        displayName: string
        nbaTeam: string | null
        position: string | null
        nbaId: string | null
        age: number | null
    } | null
}

export const NOMINATION_ORDER_MODES = ['user_nominated', 'by_projection', 'alphabetical'] as const
export type NominationOrderMode = (typeof NOMINATION_ORDER_MODES)[number]
export const ROOKIE_TIMER_EXPIRY_BEHAVIORS = ['auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick'] as const
export type RookieTimerExpiryBehavior = (typeof ROOKIE_TIMER_EXPIRY_BEHAVIORS)[number]
export type DraftTimerExpiryBehavior = RookieTimerExpiryBehavior | 'auction_no_bid'

export const NOMINATION_ORDER_MODE_LABELS: Record<NominationOrderMode, string> = {
    user_nominated: "Manager's choice",
    by_projection: 'By projection rank',
    alphabetical: 'Alphabetical',
}

export const ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS: Record<RookieTimerExpiryBehavior, string> = {
    auto_pick: 'Auto-pick',
    skip_pick: 'Skip',
    pause_draft: 'Pause',
    commissioner_pick: 'Commish pick',
}

export type Draft = {
    id: string
    leagueId: string
    status: string
    draftType: string
    isMock: boolean
    currentNominationOrder: number
    nominationOrderMode: NominationOrderMode
    budgetPerTeam: number | null
    scheduledAt: string | null
    roomName: string | null
    createdByMemberId: string | null
    pickTimerSeconds: number
    timerExpiryBehavior: DraftTimerExpiryBehavior
    rounds: number | null
    startedAt: string | null
    pauseReason: string | null
    pausedAt: string | null
    pausedRemainingSeconds: number | null
}

export type AuctionDraftStartOptions = {
    isMock?: boolean
    timerSeconds?: number
    budgetPerTeam?: number | null
}

export type DraftState = {
    draft: Draft
    order: DraftOrderEntry[]
    budgets: DraftBudget[]
    nominations: Nomination[]
    openNomination: Nomination | null
    currentNominatorMemberId: string | null
}

export type DraftSearchPlayer = {
    id: string
    display_name: string | null
    nba_team: string | null
    position: string | null
    nba_id: string | null
    dynasty_rank: number | null
    dynasty_rank_source: string | null
    dynasty_rank_fetched_at: string | null
    age: number | null
}

const DRAFT_SELECT =
    'id, league_id, status, draft_type, is_mock, current_nomination_order, nomination_order_mode, budget_per_team, scheduled_at, room_name, created_by_member_id, pick_timer_seconds, timer_expiry_behavior, rounds, started_at, pause_reason, paused_at, timer_paused_remaining_seconds'

function mapDraft(data: {
    id: string
    league_id: string
    status: string
    draft_type: string
    is_mock: boolean
    current_nomination_order: number
    nomination_order_mode: string | null
    budget_per_team: number | null
    scheduled_at: string | null
    room_name: string | null
    created_by_member_id: string | null
    pick_timer_seconds: number
    timer_expiry_behavior: string | null
    rounds: number | null
    started_at: string | null
    pause_reason: string | null
    paused_at: string | null
    timer_paused_remaining_seconds: number | null
}): Draft {
    return {
        id: data.id,
        leagueId: data.league_id,
        status: data.status,
        draftType: data.draft_type,
        isMock: data.is_mock,
        currentNominationOrder: data.current_nomination_order,
        nominationOrderMode: (data.nomination_order_mode ?? 'user_nominated') as NominationOrderMode,
        budgetPerTeam: data.budget_per_team,
        scheduledAt: data.scheduled_at,
        roomName: data.room_name,
        createdByMemberId: data.created_by_member_id,
        pickTimerSeconds: data.pick_timer_seconds,
        timerExpiryBehavior: (data.timer_expiry_behavior ?? 'auction_no_bid') as DraftTimerExpiryBehavior,
        rounds: data.rounds,
        startedAt: data.started_at,
        pauseReason: data.pause_reason,
        pausedAt: data.paused_at,
        pausedRemainingSeconds: data.timer_paused_remaining_seconds,
    }
}

async function getActiveDraft(leagueId: string): Promise<Draft | null> {
    const { data, error } = await supabase
        .from('drafts')
        .select(DRAFT_SELECT)
        .eq('league_id', leagueId)
        .eq('is_mock', false)
        .in('status', ['in_progress', 'pending', 'paused'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) throw error
    if (!data) return null

    return mapDraft(data)
}

export async function getJoinableDraft(
    leagueId: string,
    options: { includeCompletedRookie?: boolean } = {},
): Promise<Draft | null> {
    const activeDraft = await getActiveDraft(leagueId)
    if (activeDraft || !options.includeCompletedRookie) return activeDraft

    const { data: league, error: leagueError } = await supabase
        .from('leagues')
        .select('status')
        .eq('id', leagueId)
        .maybeSingle()
    if (leagueError) throw leagueError
    if (league?.status !== 'drafting') return null

    const { data, error } = await supabase
        .from('drafts')
        .select(DRAFT_SELECT)
        .eq('league_id', leagueId)
        .eq('draft_type', 'snake')
        .eq('status', 'completed')
        .eq('is_mock', false)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) throw error
    return data ? mapDraft(data) : null
}

export async function getDraftState(draftId: string): Promise<DraftState | null> {
    const [{ data: draft }, { data: orders }, { data: budgets }, { data: nominations }] =
        await Promise.all([
            supabase
                .from('drafts')
                .select(
                    'id, league_id, status, draft_type, is_mock, current_nomination_order, nomination_order_mode, budget_per_team, scheduled_at, room_name, created_by_member_id, pick_timer_seconds, timer_expiry_behavior, rounds, started_at, pause_reason, paused_at, timer_paused_remaining_seconds',
                )
                .eq('id', draftId)
                .single(),
            supabase
                .from('draft_orders')
                .select('position, member_id, league_members(team_name)')
                .eq('draft_id', draftId)
                .order('position'),
            supabase
                .from('draft_budgets')
                .select('member_id, remaining, initial_budget, league_members(team_name)')
                .eq('draft_id', draftId),
            supabase
                .from('nominations')
                .select(
                    `
        id, status, current_bid_amount, current_bidder_id, countdown_expires_at,
        winning_member_id, final_price, nominating_member_id, nominated_at, nomination_order,
        player_id,
        players ( display_name, nba_team, position, nba_id )
      `,
                )
                .eq('draft_id', draftId)
                .order('nomination_order'),
        ])

    if (!draft) return null

    const mappedDraft: Draft = {
        id: draft.id,
        leagueId: draft.league_id,
        status: draft.status,
        draftType: draft.draft_type,
        isMock: draft.is_mock,
        currentNominationOrder: draft.current_nomination_order,
        nominationOrderMode: ((draft as { nomination_order_mode?: string }).nomination_order_mode ??
            'user_nominated') as NominationOrderMode,
        budgetPerTeam: draft.budget_per_team,
        scheduledAt: draft.scheduled_at,
        roomName: draft.room_name,
        createdByMemberId: draft.created_by_member_id,
        pickTimerSeconds: draft.pick_timer_seconds,
        timerExpiryBehavior: ((draft as { timer_expiry_behavior?: string }).timer_expiry_behavior ??
            (draft.draft_type === 'auction' ? 'auction_no_bid' : 'auto_pick')) as DraftTimerExpiryBehavior,
        rounds: draft.rounds,
        startedAt: draft.started_at,
        pauseReason: draft.pause_reason,
        pausedAt: draft.paused_at,
        pausedRemainingSeconds: draft.timer_paused_remaining_seconds,
    }

    const mappedOrder: DraftOrderEntry[] = (orders ?? []).map((o) => ({
        position: o.position,
        memberId: o.member_id,
        teamName: (o.league_members as { team_name: string } | null)?.team_name ?? 'Unknown',
    }))

    const mappedBudgets: DraftBudget[] = (budgets ?? []).map((b) => ({
        memberId: b.member_id,
        teamName: (b.league_members as { team_name: string } | null)?.team_name ?? 'Unknown',
        remaining: b.remaining,
        initialBudget: b.initial_budget,
    }))

    const playerIds = [...new Set((nominations ?? []).map((n) => n.player_id).filter(Boolean))]
    const ageByPlayerId = await getLatestDynastyAges(playerIds)

    type PlayerRef = { display_name: string | null; nba_team: string | null; position: string | null; nba_id: string | null }
    const mappedNominations: Nomination[] = (nominations ?? []).map((n) => ({
        id: n.id,
        status: n.status,
        nominatingMemberId: n.nominating_member_id,
        currentBidAmount: n.current_bid_amount,
        currentBidderId: n.current_bidder_id,
        countdownExpiresAt: n.countdown_expires_at,
        winningMemberId: n.winning_member_id,
        finalPrice: n.final_price,
        nominatedAt: n.nominated_at,
        nominationOrder: n.nomination_order,
        player: n.players
            ? {
                  displayName: (n.players as PlayerRef).display_name ?? 'Unknown',
                  nbaTeam: (n.players as PlayerRef).nba_team,
                  position: (n.players as PlayerRef).position,
                  nbaId: (n.players as PlayerRef).nba_id,
                  age: ageByPlayerId.get(n.player_id) ?? null,
              }
            : null,
    }))

    const openNomination = mappedNominations.find((n) => n.status === 'open') ?? null

    const numManagers = mappedOrder.length
    let currentNominatorMemberId: string | null = null
    if (numManagers > 0) {
        const turnIndex = (draft.current_nomination_order - 1) % numManagers
        currentNominatorMemberId = mappedOrder[turnIndex]?.memberId ?? null
    }

    return {
        draft: mappedDraft,
        order: mappedOrder,
        budgets: mappedBudgets,
        nominations: mappedNominations,
        openNomination,
        currentNominatorMemberId,
    }
}


export async function searchPlayers(
    query: string,
    draftId: string,
    mode: NominationOrderMode = 'user_nominated',
): Promise<DraftSearchPlayer[]> {
    // Get already-nominated player IDs to filter out
    const { data: nominated } = await supabase
        .from('nominations')
        .select('player_id')
        .eq('draft_id', draftId)

    const nominatedIds = new Set((nominated ?? []).map((n) => n.player_id))

    // Nomination board order follows the draft's mode: alphabetical sorts A→Z;
    // by_projection / user_nominated use dynasty rank (Hashtag's list isn't every
    // NBA player, so unranked players fall back alphabetically).
    let playerQuery = supabase
        .from('players')
        .select('id, display_name, nba_team, position, nba_id, dynasty_rank, dynasty_rank_source, dynasty_rank_fetched_at')
    playerQuery =
        mode === 'alphabetical'
            ? playerQuery.order('last_name').order('display_name')
            : playerQuery.order('dynasty_rank', { ascending: true, nullsFirst: false }).order('last_name')
    playerQuery = playerQuery.limit(20)

    if (nominatedIds.size > 0) playerQuery = playerQuery.not('id', 'in', postgresInList([...nominatedIds]))

    const trimmed = query.trim()
    if (trimmed) playerQuery = playerQuery.ilike('display_name', `%${trimmed}%`)

    const { data, error } = await playerQuery

    if (error) console.error('[searchPlayers]', error)
    const rows = (data ?? []) as Omit<DraftSearchPlayer, 'age'>[]
    const ageByPlayerId = await getLatestDynastyAges(rows.map((row) => row.id))
    return rows.map((row) => ({
        ...row,
        age: ageByPlayerId.get(row.id) ?? null,
    }))
}

function postgresInList(values: string[]): string {
    return `(${values.join(',')})`
}

async function getLatestDynastyAges(playerIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(playerIds.filter(Boolean))]
    if (ids.length === 0) return new Map()

    const { data, error } = await supabase
        .from('dynasty_rankings')
        .select('player_id, age, fetched_at')
        .in('player_id', ids)
        .not('age', 'is', null)
        .order('fetched_at', { ascending: false })

    if (error) {
        console.error('[getLatestDynastyAges]', error)
        return new Map()
    }

    const ages = new Map<string, number>()
    for (const row of (data ?? []) as { player_id: string | null; age: number | string | null }[]) {
        if (!row.player_id || ages.has(row.player_id) || row.age == null) continue
        ages.set(row.player_id, Number(row.age))
    }
    return ages
}


export async function startDraft(
    leagueId: string,
    nominationOrderMode: NominationOrderMode = 'user_nominated',
    options: AuctionDraftStartOptions = {},
): Promise<Draft> {
    const json = await sharedApiPost<any>('/draft/start', {
        leagueId,
        nominationOrderMode,
        isMock: options.isMock === true,
        ...(options.timerSeconds != null ? { timerSeconds: options.timerSeconds } : {}),
        ...(options.budgetPerTeam != null ? { budgetPerTeam: options.budgetPerTeam } : {}),
    })
    return {
        id: json.draft.id,
        leagueId: json.draft.league_id,
        status: json.draft.status,
        draftType: json.draft.draft_type ?? 'auction',
        isMock: json.draft.is_mock ?? false,
        currentNominationOrder: json.draft.current_nomination_order,
        nominationOrderMode: (json.draft.nomination_order_mode ?? 'user_nominated') as NominationOrderMode,
        budgetPerTeam: json.draft.budget_per_team,
        scheduledAt: json.draft.scheduled_at ?? null,
        roomName: json.draft.room_name ?? null,
        createdByMemberId: json.draft.created_by_member_id ?? null,
        pickTimerSeconds: json.draft.pick_timer_seconds ?? 30,
        timerExpiryBehavior: (json.draft.timer_expiry_behavior ??
            (json.draft.draft_type === 'auction' ? 'auction_no_bid' : 'auto_pick')) as DraftTimerExpiryBehavior,
        rounds: json.draft.rounds ?? null,
        startedAt: json.draft.started_at,
        pauseReason: json.draft.pause_reason ?? null,
        pausedAt: json.draft.paused_at ?? null,
        pausedRemainingSeconds: json.draft.timer_paused_remaining_seconds ?? null,
    }
}

export async function stopDraft(draftId: string): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/stop`, {})
}

export async function resetDraft(draftId: string): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/reset`, {})
}

export async function pauseDraft(draftId: string): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/pause`, {})
}

export async function resumeDraft(draftId: string): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/resume`, {})
}

export async function nominatePlayer(
    draftId: string,
    memberId: string,
    playerId: string,
): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/nominate`, { memberId, playerId })
}

export async function placeBid(
    draftId: string,
    memberId: string,
    nominationId: string,
    amount: number,
): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/bid`, { memberId, nominationId, amount })
}

export async function withdrawNomination(
    draftId: string,
    memberId: string,
    nominationId: string,
): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/withdraw-nomination`, { memberId, nominationId })
}

export async function closeExpiredNominations(draftId: string): Promise<{ closed: number }> {
    const res = await sharedApiPost<{ closed: number }>(`/draft/${draftId}/close-expired`, {})
    return { closed: res?.closed ?? 0 }
}

export async function pauseForAbsence(draftId: string): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/pause-for-absence`, {})
}

export async function resumeIfAbsent(draftId: string): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/resume-if-absent`, {})
}

export type DraftPresenceOptions = {
    memberId: string
    onSync: (presentMemberIds: string[]) => void
}

export function subscribeToDraft(
    draftId: string,
    onChange: () => void,
    presence?: DraftPresenceOptions,
): RealtimeChannel {
    const channel = supabase
        .channel(`draft:${draftId}`, { config: { private: true } })
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'nominations',
                filter: `draft_id=eq.${draftId}`,
            },
            onChange,
        )
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bids' }, onChange)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'draft_budgets',
                filter: `draft_id=eq.${draftId}`,
            },
            onChange,
        )
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'drafts', filter: `id=eq.${draftId}` },
            onChange,
        )

    if (presence) {
        channel.on('presence', { event: 'sync' }, () => {
            const state = channel.presenceState<{ memberId: string }>()
            const ids = [...new Set(Object.values(state).flat().map((p) => p.memberId))]
            presence.onSync(ids)
        })
    }

    channel.subscribe((status) => {
        if (status === 'SUBSCRIBED' && presence) {
            channel.track({ memberId: presence.memberId })
        }
    })

    return channel
}

export function unsubscribeFromDraft(channel: RealtimeChannel) {
    supabase.removeChannel(channel)
}
