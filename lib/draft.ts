import { supabase } from '@/lib/supabase'
import { RealtimeChannel } from '@supabase/supabase-js'
import { apiPost as sharedApiPost } from '@/lib/shared/api'
import { subscribeToTableChanges, unsubscribeFromTableChanges } from '@/lib/realtime'
import type { RealtimeSubscriptionStatus } from '@/lib/realtime'
import { assertReadActive } from '@/lib/shared/read-admission'
import { onSessionCachesCleared, sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'

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
    currentBidToTaxi?: boolean
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
        yearsExp?: number | null
        careerGames?: number | null
        injuryStatus?: string | null
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
    pollRevision?: string | null
    draft: Draft
    order: DraftOrderEntry[]
    budgets: DraftBudget[]
    nominations: DraftNomination[]
    activeBids: AuctionBid[]
    openNomination: DraftNomination | null
    currentNominatorMemberId: string | null
}

export type DraftSearchPlayer = {
    injury_status?: string | null
    years_exp?: number | null
    career_regular_season_games?: number | null
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
    options: { includeCompletedRookie?: boolean; canRead?: () => boolean } = {},
): Promise<Draft | null> {
    const { canRead } = options
    assertReadActive(canRead)
    const activeDraft = await getActiveDraft(leagueId)
    assertReadActive(canRead)
    if (activeDraft || !options.includeCompletedRookie) return activeDraft

    const { data: league, error: leagueError } = await supabase
        .from('leagues')
        .select('status')
        .eq('id', leagueId)
        .maybeSingle()
    assertReadActive(canRead)
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

    assertReadActive(canRead)
    if (error) throw error
    return data ? mapDraft(data) : null
}

type PendingJoinableDraft = {
    readers: Set<() => boolean>
    promise: Promise<Draft | null>
}

const pendingJoinableDrafts = new Map<string, PendingJoinableDraft>()

onSessionCachesCleared(() => {
    for (const pending of pendingJoinableDrafts.values()) pending.readers.clear()
    pendingJoinableDrafts.clear()
})

function hasJoinableDraftReaders(readers: Set<() => boolean>): boolean {
    for (const canRead of readers) if (!canRead()) readers.delete(canRead)
    return readers.size > 0
}

export function acquireJoinableDraft(
    leagueId: string,
    options: { memberId?: string; includeCompletedRookie?: boolean; canRead: () => boolean },
): { promise: Promise<Draft | null>; release: () => void } {
    const actor = sessionOwner()
    const generation = sessionGeneration()
    const { canRead, memberId, includeCompletedRookie = false } = options
    const key = JSON.stringify([actor, generation, leagueId, memberId ?? null, includeCompletedRookie])
    const admitted = () => actor != null && sessionOwner() === actor && sessionGeneration() === generation && canRead()
    let pending = pendingJoinableDrafts.get(key)
    if (pending && !hasJoinableDraftReaders(pending.readers)) {
        pendingJoinableDrafts.delete(key)
        pending = undefined
    }
    if (pending) {
        pending.readers.add(admitted)
    } else {
        const readers = new Set([admitted])
        pending = {
            readers,
            promise: getJoinableDraft(leagueId, { includeCompletedRookie, canRead: () => hasJoinableDraftReaders(readers) }),
        }
        pendingJoinableDrafts.set(key, pending)
    }
    const owned = pending
    const evict = () => {
        if (pendingJoinableDrafts.get(key) === owned) pendingJoinableDrafts.delete(key)
    }
    void owned.promise.then(evict, evict)
    const release = () => {
        owned.readers.delete(admitted)
        if (!hasJoinableDraftReaders(owned.readers)) evict()
    }
    const promise = owned.promise.then(draft => {
        assertReadActive(() => owned.readers.has(admitted) && admitted())
        return draft
    }).finally(release)
    return { promise, release }
}

export async function searchPlayers(
    query: string,
    draftId: string,
    mode: NominationOrderMode = 'user_nominated',
): Promise<DraftSearchPlayer[]> {
    // Nomination board order follows the draft's mode: alphabetical sorts A→Z;
    // by_projection / user_nominated use dynasty rank (Hashtag's list isn't every
    // NBA player, so unranked players fall back alphabetically).
    let playerQuery = supabase
        .from('players')
        .select('id, display_name, nba_team, position, nba_id, injury_status, years_exp, career_regular_season_games, dynasty_rank, dynasty_rank_source, dynasty_rank_fetched_at, nominated:nominations!nominations_player_id_fkey()')
        .eq('nominated.draft_id', draftId)
        .is('nominated', null)
    playerQuery =
        mode === 'alphabetical'
            ? playerQuery.order('last_name').order('display_name')
            : playerQuery.order('dynasty_rank', { ascending: true, nullsFirst: false }).order('last_name')
    playerQuery = playerQuery.limit(20)

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

const DYNASTY_AGE_ROW_CAP = 2000
const DYNASTY_AGE_ID_CHUNK = 100

async function getLatestDynastyAges(playerIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(playerIds.filter(Boolean))]
    const ages = new Map<string, number>()
    for (let offset = 0; offset < ids.length; offset += DYNASTY_AGE_ID_CHUNK) {
        const { data, error } = await supabase
            .from('dynasty_rankings')
            .select('player_id, age, fetched_at')
            .in('player_id', ids.slice(offset, offset + DYNASTY_AGE_ID_CHUNK))
            .not('age', 'is', null)
            .order('fetched_at', { ascending: false })
            .limit(DYNASTY_AGE_ROW_CAP)
        if (error) throw error
        for (const row of (data ?? []) as { player_id: string | null; age: number | string | null }[]) {
            if (!row.player_id || ages.has(row.player_id) || row.age == null) continue
            ages.set(row.player_id, Number(row.age))
        }
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
    toTaxi = false,
): Promise<void> {
    await sharedApiPost(`/draft/${draftId}/bid`, { memberId, nominationId, amount, toTaxi })
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

export function subscribeToDraft(
    draftId: string,
    _leagueId: string | null | undefined,
    onChange: () => void,
    onStatus?: (status: RealtimeSubscriptionStatus) => void,
    onReconnect?: () => Promise<boolean>,
): RealtimeChannel {
    return subscribeToTableChanges(`draft:${draftId}`, {
        mode: 'fallback',
        watches: [
            { table: 'nominations', filter: `draft_id=eq.${draftId}` },
            { table: 'draft_budgets', filter: `draft_id=eq.${draftId}` },
            { table: 'drafts', event: 'UPDATE', filter: `id=eq.${draftId}` },
        ],
        onChange,
        onStatus,
        onReconnect,
    })
}

export async function unsubscribeFromDraft(channel: RealtimeChannel): Promise<void> {
    await unsubscribeFromTableChanges(channel)
}
