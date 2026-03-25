import { supabase } from '@/lib/supabase'
import { RealtimeChannel } from '@supabase/supabase-js'

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

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
    status: 'open' | 'sold' | 'no_bid'
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
    } | null
}

export type Draft = {
    id: string
    leagueId: string
    status: string
    currentNominationOrder: number
    budgetPerTeam: number | null
    startedAt: string | null
}

export type DraftState = {
    draft: Draft
    order: DraftOrderEntry[]
    budgets: DraftBudget[]
    nominations: Nomination[]
    openNomination: Nomination | null
    currentNominatorMemberId: string | null
}

// ── Data fetching ──────────────────────────────────────────────

export async function getActiveDraft(leagueId: string): Promise<Draft | null> {
    const { data } = await supabase
        .from('drafts')
        .select('id, league_id, status, current_nomination_order, budget_per_team, started_at')
        .eq('league_id', leagueId)
        .in('status', ['in_progress', 'pending'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (!data) return null

    return {
        id: data.id,
        leagueId: data.league_id,
        status: data.status,
        currentNominationOrder: data.current_nomination_order,
        budgetPerTeam: data.budget_per_team,
        startedAt: data.started_at,
    }
}

export async function getDraftState(draftId: string): Promise<DraftState | null> {
    const [{ data: draft }, { data: orders }, { data: budgets }, { data: nominations }] =
        await Promise.all([
            supabase
                .from('drafts')
                .select(
                    'id, league_id, status, current_nomination_order, budget_per_team, started_at',
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
        players ( display_name, nba_team, position )
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
        currentNominationOrder: draft.current_nomination_order,
        budgetPerTeam: draft.budget_per_team,
        startedAt: draft.started_at,
    }

    const mappedOrder: DraftOrderEntry[] = (orders ?? []).map((o: any) => ({
        position: o.position,
        memberId: o.member_id,
        teamName: o.league_members?.team_name ?? 'Unknown',
    }))

    const mappedBudgets: DraftBudget[] = (budgets ?? []).map((b: any) => ({
        memberId: b.member_id,
        teamName: b.league_members?.team_name ?? 'Unknown',
        remaining: b.remaining,
        initialBudget: b.initial_budget,
    }))

    const mappedNominations: Nomination[] = (nominations ?? []).map((n: any) => ({
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
                  displayName: n.players.display_name,
                  nbaTeam: n.players.nba_team,
                  position: n.players.position,
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

// ── Player search for nomination ───────────────────────────────

export async function searchPlayers(query: string, draftId: string) {
    // Get already-nominated player IDs to filter out
    const { data: nominated } = await supabase
        .from('nominations')
        .select('player_id')
        .eq('draft_id', draftId)

    const nominatedIds = new Set((nominated ?? []).map((n: any) => n.player_id))

    // Search players by name
    const { data, error } = await supabase
        .from('players')
        .select('id, display_name, nba_team, position')
        .ilike('display_name', `%${query}%`)
        .order('last_name')
        .limit(20)

    if (error) console.error('[searchPlayers]', error)
    return (data ?? []).filter((p: any) => !nominatedIds.has(p.id))
}

// ── API calls to backend ───────────────────────────────────────

async function apiPost(path: string, body: object) {
    const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    const text = await res.text()
    let json: any
    try {
        json = JSON.parse(text)
    } catch {
        throw new Error(`Server error (${res.status}): ${text.slice(0, 100)}`)
    }
    if (!json.ok) throw new Error(json.error || `Backend error: ${text.slice(0, 200)}`)
    return json
}

export async function startDraft(leagueId: string): Promise<Draft> {
    const json = await apiPost('/draft/start', { leagueId })
    return {
        id: json.draft.id,
        leagueId: json.draft.league_id,
        status: json.draft.status,
        currentNominationOrder: json.draft.current_nomination_order,
        budgetPerTeam: json.draft.budget_per_team,
        startedAt: json.draft.started_at,
    }
}

export async function nominatePlayer(
    draftId: string,
    memberId: string,
    playerId: string,
): Promise<void> {
    await apiPost(`/draft/${draftId}/nominate`, { memberId, playerId })
}

export async function placeBid(
    draftId: string,
    memberId: string,
    nominationId: string,
    amount: number,
): Promise<void> {
    await apiPost(`/draft/${draftId}/bid`, { memberId, nominationId, amount })
}

// ── Realtime subscription ──────────────────────────────────────

export function subscribeToDraft(draftId: string, onChange: () => void): RealtimeChannel {
    const channel = supabase
        .channel(`draft:${draftId}`)
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
        .subscribe()

    return channel
}

export function unsubscribeFromDraft(channel: RealtimeChannel) {
    supabase.removeChannel(channel)
}
