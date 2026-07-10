import { supabase } from '@/lib/supabase'
import { RealtimeChannel } from '@supabase/supabase-js'
import { apiPost as sharedApiPost } from '@/lib/shared/api'
import { subscribeToTableChanges } from '@/lib/realtime'

type DraftOrderEntry = {
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

export type DraftNomination = {
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

type AuctionBid = {
    id: string
    nominationId: string
    memberId: string
    teamName: string
    amount: number
    placedAt: string
}

export const NOMINATION_ORDER_MODES = ['user_nominated', 'by_projection', 'alphabetical'] as const
export type NominationOrderMode = (typeof NOMINATION_ORDER_MODES)[number]
export const ROOKIE_TIMER_EXPIRY_BEHAVIORS = ['auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick'] as const
export type RookieTimerExpiryBehavior = (typeof ROOKIE_TIMER_EXPIRY_BEHAVIORS)[number]
type DraftTimerExpiryBehavior = RookieTimerExpiryBehavior | 'auction_no_bid'

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
    nominations: DraftNomination[]
    activeBids: AuctionBid[]
    openNomination: DraftNomination | null
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
    const [draftResult, ordersResult, budgetsResult, nominationsResult] =
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
    if (draftResult.error) throw draftResult.error
    if (ordersResult.error) throw ordersResult.error
    if (budgetsResult.error) throw budgetsResult.error
    if (nominationsResult.error) throw nominationsResult.error

    const draft = draftResult.data
    if (!draft) return null
    const orders = ordersResult.data ?? []
    const budgets = budgetsResult.data ?? []
    const nominations = nominationsResult.data ?? []

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

    const mappedOrder: DraftOrderEntry[] = orders.map((o) => ({
        position: o.position,
        memberId: o.member_id,
        teamName: (o.league_members as { team_name: string } | null)?.team_name ?? 'Unknown',
    }))

    const mappedBudgets: DraftBudget[] = budgets.map((b) => ({
        memberId: b.member_id,
        teamName: (b.league_members as { team_name: string } | null)?.team_name ?? 'Unknown',
        remaining: b.remaining,
        initialBudget: b.initial_budget,
    }))

    const playerIds = [...new Set(nominations.map((n) => n.player_id).filter(Boolean))]
    const ageByPlayerId = await getLatestDynastyAges(playerIds)

    type PlayerRef = { display_name: string | null; nba_team: string | null; position: string | null; nba_id: string | null }
    const mappedNominations: DraftNomination[] = nominations.map((n) => ({
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
    let activeBids: AuctionBid[] = []
    if (openNomination) {
        const { data: bids, error: bidsError } = await supabase
            .from('bids')
            .select('id, nomination_id, member_id, amount, placed_at, league_members(team_name)')
            .eq('nomination_id', openNomination.id)
            .order('placed_at', { ascending: false })

        if (bidsError) throw bidsError
        activeBids = (bids ?? []).map((bid) => ({
            id: bid.id,
            nominationId: bid.nomination_id,
            memberId: bid.member_id,
            teamName: (bid.league_members as { team_name: string } | null)?.team_name ?? 'Unknown',
            amount: bid.amount,
            placedAt: bid.placed_at,
        }))
    }

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
        activeBids,
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
    const { data: nominated, error: nominatedError } = await supabase
        .from('nominations')
        .select('player_id')
        .eq('draft_id', draftId)
    if (nominatedError) throw nominatedError

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

    if (error) throw error
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

    if (error) throw error

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

export async function resumeIfAbsent(draftId: string, claims: string[]): Promise<{ resumed: boolean }> {
    return sharedApiPost<{ resumed: boolean }>(`/draft/${draftId}/resume-if-absent`, { claims })
}

export function subscribeToDraft(draftId: string, leagueId: string | null | undefined, onChange: () => void): RealtimeChannel {
    return subscribeToTableChanges(`draft:${draftId}`, {
        mode: 'fallback',
        watches: [
            { table: 'nominations', filter: `draft_id=eq.${draftId}` },
            { table: 'draft_budgets', filter: `draft_id=eq.${draftId}` },
            { table: 'drafts', event: 'UPDATE', filter: `id=eq.${draftId}` },
            ...(leagueId ? [{ table: 'bids', filter: `league_id=eq.${leagueId}` }] : []),
        ],
        onChange,
    })
}

// Presence uses a separate public channel because private channels require
// additional RLS setup on realtime.messages for broadcast/presence to work.
// postgres_changes (handled by subscribeToDraft) works fine on private channels.
export type DraftPresenceSubscription = {
    channel: RealtimeChannel
    dispose: () => Promise<void>
}

export type DraftPresenceSnapshot = {
    memberIds: string[]
    claims: string[]
}

const PRESENCE_CLAIM_REFRESH_MS = 4 * 60 * 1000

export async function subscribeToPresence(
    draftId: string,
    onSync: (snapshot: DraftPresenceSnapshot) => void,
    onError: (error: unknown) => void,
): Promise<DraftPresenceSubscription> {
    let claim = (await sharedApiPost<{ claim: string }>(`/draft/${draftId}/presence-claim`, {})).claim
    const channel = supabase.channel(`draft-presence:${draftId}`)
    let disposed = false
    let snapshotSequence = 0

    const snapshot = async () => {
        const sequence = ++snapshotSequence
        const state = channel.presenceState<{ claim?: string }>()
        const claims = [...new Set(Object.values(state).flat().flatMap((entry) =>
            typeof entry.claim === 'string' ? [entry.claim] : []))]
        try {
            const result = await sharedApiPost<{ memberIds: string[] }>(`/draft/${draftId}/resolve-presence`, { claims })
            if (!disposed && sequence === snapshotSequence) onSync({ memberIds: result.memberIds, claims })
        } catch (error) {
            if (!disposed && sequence === snapshotSequence) onError(error)
        }
    }

    // Listen to both 'sync' and 'join' so that rejoining members are detected
    // reliably. 'sync' fires for the initial state and after leaves; 'join' fires
    // specifically when new presences are added, which is the event we need for
    // auto-resume to work.
    channel.on('presence', { event: 'sync' }, () => { void snapshot() })
    channel.on('presence', { event: 'join' }, () => { void snapshot() })

    channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
            void channel.track({ claim }).catch(onError)
        }
    })

    const refresh = setInterval(() => {
        void sharedApiPost<{ claim: string }>(`/draft/${draftId}/presence-claim`, {})
            .then((result) => {
                if (disposed) return
                claim = result.claim
                return channel.track({ claim })
            })
            .catch((error) => { if (!disposed) onError(error) })
    }, PRESENCE_CLAIM_REFRESH_MS)

    return {
        channel,
        dispose: async () => {
            disposed = true
            snapshotSequence += 1
            clearInterval(refresh)
            await supabase.removeChannel(channel)
        },
    }
}

export async function unsubscribeFromDraft(channel: RealtimeChannel): Promise<void> {
    await supabase.removeChannel(channel)
}
