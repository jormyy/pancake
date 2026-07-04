import { supabase } from '@/lib/supabase'
import { RealtimeChannel } from '@supabase/supabase-js'
import { apiPost as sharedApiPost } from '@/lib/shared/api'
import type { RookieTimerExpiryBehavior } from '@/lib/draft'


export type SnakePick = {
    overallPick: number
    round: number
    pickInRound: number
    memberId: string
    teamName: string
    pickedAt: string | null
    skippedAt: string | null
    skipReason: string | null
    timerExpiresAt: string | null
    player: {
        id: string
        displayName: string
        nbaTeam: string | null
        position: string | null
    } | null
}

export type RookieDraftState = {
    draft: {
        id: string
        leagueId: string
        status: string
        isMock: boolean
        pickTimerSeconds: number
        timerExpiryBehavior: RookieTimerExpiryBehavior
        rounds: number | null
        startedAt: string | null
        completedAt: string | null
        pauseReason: string | null
        pausedAt: string | null
        pausedRemainingSeconds: number | null
    }
    picks: SnakePick[]
    orders: { position: number; memberId: string; teamName: string }[]
    nextPick: SnakePick | null
}

export type RookieProspect = {
    id: string
    display_name: string
    nba_team: string | null
    position: string | null
    nba_draft_number: number | null
}

export type LeaguePickItem = {
    id: string
    seasonYear: number
    round: number
    isUsed: boolean
    originalOwnerMemberId: string
    originalTeamName: string
    currentOwnerMemberId: string
    currentTeamName: string
}

export type RookieDraftStartOptions = {
    isMock?: boolean
    timerSeconds?: number
    rounds?: number
    timerExpiryBehavior?: RookieTimerExpiryBehavior
}


export async function getActiveRookieDraft(leagueId: string) {
    const { data } = await supabase
        .from('drafts')
        .select('id, league_id, status, draft_type, is_mock, pick_timer_seconds, timer_expiry_behavior, rounds, started_at, pause_reason, paused_at, timer_paused_remaining_seconds')
        .eq('league_id', leagueId)
        .eq('draft_type', 'snake')
        .eq('is_mock', false)
        .in('status', ['in_progress', 'pending', 'paused'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    return data
}

export async function activateRookieDraftLeague(draftId: string): Promise<boolean> {
    const result = await sharedApiPost<{ activated?: boolean }>(`/draft/${draftId}/activate-rookie-league`, {})
    return Boolean(result?.activated)
}

export async function getRookieDraftState(draftId: string): Promise<RookieDraftState | null> {
    const [draftResult, { data: picks }, { data: orders }] = await Promise.all([
        supabase
            .from('drafts')
            .select('id, league_id, status, is_mock, pick_timer_seconds, timer_expiry_behavior, rounds, started_at, completed_at, pause_reason, paused_at, timer_paused_remaining_seconds')
            .eq('id', draftId)
            .single(),
        supabase
            .from('snake_draft_picks')
            .select(
                `overall_pick, round, pick_in_round, member_id, picked_at, skipped_at, skip_reason, timer_expires_at,
                 players ( id, display_name, nba_team, position ),
                 league_members ( team_name )`,
            )
            .eq('draft_id', draftId)
            .order('overall_pick'),
        supabase
            .from('draft_orders')
            .select('position, member_id, league_members ( team_name )')
            .eq('draft_id', draftId)
            .order('position'),
    ])

    const draft = draftResult.data
    if (!draft) return null

    const mappedPicks: SnakePick[] = (picks ?? []).map((p) => ({
        overallPick: p.overall_pick,
        round: p.round,
        pickInRound: p.pick_in_round,
        memberId: p.member_id,
        teamName: (p.league_members as { team_name: string } | null)?.team_name ?? 'Unknown',
        pickedAt: p.picked_at,
        skippedAt: p.skipped_at,
        skipReason: p.skip_reason,
        timerExpiresAt: p.timer_expires_at,
        player: p.players
            ? {
                  id: (p.players as { id: string }).id,
                  displayName: (p.players as { display_name: string }).display_name ?? 'Unknown',
                  nbaTeam: (p.players as { nba_team: string | null }).nba_team,
                  position: (p.players as { position: string | null }).position,
              }
            : null,
    }))

    return {
        draft: {
            id: draft.id,
            leagueId: draft.league_id,
            status: draft.status,
            isMock: draft.is_mock,
            pickTimerSeconds: draft.pick_timer_seconds,
            timerExpiryBehavior: (draft.timer_expiry_behavior ?? 'auto_pick') as RookieTimerExpiryBehavior,
            rounds: draft.rounds,
            startedAt: draft.started_at,
            completedAt: draft.completed_at,
            pauseReason: draft.pause_reason,
            pausedAt: draft.paused_at,
            pausedRemainingSeconds: draft.timer_paused_remaining_seconds,
        },
        picks: mappedPicks,
        orders: (orders ?? []).map((o) => ({
            position: o.position,
            memberId: o.member_id,
            teamName: (o.league_members as { team_name: string } | null)?.team_name ?? 'Unknown',
        })),
        nextPick: mappedPicks.find((p) => !p.player && !p.skippedAt) ?? null,
    }
}

export async function getAllLeaguePicks(leagueId: string): Promise<LeaguePickItem[]> {
    const { data, error } = await supabase
        .from('draft_picks')
        .select(
            `id, season_year, round, is_used,
             original_owner_id,
             current_owner_id,
             original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name ),
             current_owner:league_members!draft_picks_current_owner_id_fkey ( team_name )`,
        )
        .eq('league_id', leagueId)
        .eq('is_used', false)
        .order('season_year', { ascending: true })
        .order('round', { ascending: true })

    if (error) throw error
    type PickRow = (typeof data extends (infer T)[] | null ? T : never) & {
        original_owner: { team_name: string } | null
        current_owner: { team_name: string } | null
    }
    return ((data ?? []) as PickRow[]).map((p) => ({
        id: p.id,
        seasonYear: p.season_year,
        round: p.round,
        isUsed: p.is_used,
        originalOwnerMemberId: p.original_owner_id,
        originalTeamName: p.original_owner?.team_name ?? 'Unknown',
        currentOwnerMemberId: p.current_owner_id,
        currentTeamName: p.current_owner?.team_name ?? 'Unknown',
    }))
}

export async function searchDraftablePlayers(query: string, draftId: string) {
    const { data: picked } = await supabase
        .from('snake_draft_picks')
        .select('player_id')
        .eq('draft_id', draftId)
        .not('player_id', 'is', null)

    const pickedIds = new Set((picked ?? []).map((p) => p.player_id))

    const { data } = await supabase
        .from('players')
        .select('id, display_name, nba_team, position')
        .ilike('display_name', `%${query}%`)
        .eq('years_exp', 0)
        .order('last_name')
        .limit(20)

    return (data ?? []).filter((p) => !pickedIds.has(p.id))
}

export async function getRookiePlayers(draftId: string, query?: string): Promise<RookieProspect[]> {
    const { data: picked } = await supabase
        .from('snake_draft_picks')
        .select('player_id')
        .eq('draft_id', draftId)
        .not('player_id', 'is', null)

    const pickedIds = new Set((picked ?? []).map((p) => p.player_id))

    let q = supabase
        .from('players')
        .select('id, display_name, nba_team, position, nba_draft_number')
        .not('nba_draft_number', 'is', null)
        .eq('years_exp', 0)
        .order('nba_draft_number', { ascending: true })
        .order('id', { ascending: true })
        .limit(100)

    if (query?.trim()) {
        q = q.ilike('display_name', `%${query.trim()}%`)
    }

    const { data, error } = await q
    if (error) {
        console.error('[getRookiePlayers] query error:', error.message)
        let fallback = supabase
            .from('players')
            .select('id, display_name, nba_team, position')
            .not('nba_draft_number', 'is', null)
            .eq('years_exp', 0)
            .order('nba_draft_number', { ascending: true })
            .order('id', { ascending: true })
            .limit(100)
        if (query?.trim()) fallback = fallback.ilike('display_name', `%${query.trim()}%`)
        const { data: fbData } = await fallback
        return (fbData ?? []).filter((p) => !pickedIds.has(p.id)) as RookieProspect[]
    }
    return (data ?? []).filter((p) => !pickedIds.has(p.id)) as RookieProspect[]
}


export async function startRookieDraft(leagueId: string, options: RookieDraftStartOptions = {}) {
    return sharedApiPost<any>('/draft/start-rookie', {
        leagueId,
        isMock: options.isMock === true,
        ...(options.timerSeconds != null ? { timerSeconds: options.timerSeconds } : {}),
        ...(options.rounds != null ? { rounds: options.rounds } : {}),
        ...(options.timerExpiryBehavior ? { timerExpiryBehavior: options.timerExpiryBehavior } : {}),
    })
}

export async function makeSnakePick(draftId: string, memberId: string, playerId: string) {
    return sharedApiPost<any>(`/draft/${draftId}/snake-pick`, { memberId, playerId })
}

export async function commissionerSnakePick(draftId: string, memberId: string, playerId: string) {
    return sharedApiPost<any>(`/draft/${draftId}/commissioner-pick`, { memberId, playerId })
}

export async function autoPickBest(draftId: string, memberId: string) {
    // Server picks best available — only memberId is required by AutoPickBody.
    // Sending playerId: '' here would fail the UUID-format check in the schema
    // and 400 before the handler runs (breaks the pick-clock auto-pick path).
    return sharedApiPost<any>(`/draft/${draftId}/auto-pick`, { memberId })
}

export async function processExpiredSnakePick(draftId: string, memberId: string) {
    return sharedApiPost<any>(`/draft/${draftId}/process-expired-pick`, { memberId })
}

export async function reseedRookieDraftPicks(draftId: string) {
    return sharedApiPost<any>(`/draft/${draftId}/reseed-picks`, {})
}

export async function advanceSeason(leagueId: string) {
    return sharedApiPost<any>('/league/advance-season', { leagueId })
}


export function subscribeToRookieDraft(draftId: string, onChange: () => void): RealtimeChannel {
    return supabase
        .channel(`rookie-draft:${draftId}`, { config: { private: true } })
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'snake_draft_picks',
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
}

export function unsubscribeFromRookieDraft(channel: RealtimeChannel) {
    supabase.removeChannel(channel)
}
