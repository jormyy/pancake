import { supabase } from '@/lib/supabase'
import { RealtimeChannel } from '@supabase/supabase-js'

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

// ── Types ──────────────────────────────────────────────────────

export type SnakePick = {
    overallPick: number
    round: number
    pickInRound: number
    memberId: string
    teamName: string
    pickedAt: string | null
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
        startedAt: string | null
        completedAt: string | null
    }
    picks: SnakePick[]
    orders: { position: number; memberId: string; teamName: string }[]
    nextPick: SnakePick | null
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

// ── Queries ────────────────────────────────────────────────────

export async function getActiveRookieDraft(leagueId: string) {
    const { data } = await supabase
        .from('drafts')
        .select('id, league_id, status, draft_type, started_at')
        .eq('league_id', leagueId)
        .eq('draft_type', 'snake')
        .in('status', ['in_progress', 'pending'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    return data
}

export async function getRookieDraftState(draftId: string): Promise<RookieDraftState | null> {
    const [draftResult, { data: picks }, { data: orders }] = await Promise.all([
        supabase
            .from('drafts')
            .select('id, league_id, status, started_at, completed_at')
            .eq('id', draftId)
            .single(),
        supabase
            .from('snake_draft_picks')
            .select(
                `overall_pick, round, pick_in_round, member_id, picked_at,
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

    const draft = draftResult.data as any
    if (!draft) return null

    const mappedPicks: SnakePick[] = (picks ?? []).map((p: any) => ({
        overallPick: p.overall_pick,
        round: p.round,
        pickInRound: p.pick_in_round,
        memberId: p.member_id,
        teamName: p.league_members?.team_name ?? 'Unknown',
        pickedAt: p.picked_at,
        player: p.players
            ? {
                  id: p.players.id,
                  displayName: p.players.display_name,
                  nbaTeam: p.players.nba_team,
                  position: p.players.position,
              }
            : null,
    }))

    return {
        draft: {
            id: draft.id,
            leagueId: draft.league_id,
            status: draft.status,
            startedAt: draft.started_at,
            completedAt: draft.completed_at,
        },
        picks: mappedPicks,
        orders: (orders ?? []).map((o: any) => ({
            position: o.position,
            memberId: o.member_id,
            teamName: o.league_members?.team_name ?? 'Unknown',
        })),
        nextPick: mappedPicks.find((p) => !p.player) ?? null,
    }
}

export async function getAllLeaguePicks(leagueId: string): Promise<LeaguePickItem[]> {
    const { data, error } = await (supabase as any)
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

    if (error) console.error('[getAllLeaguePicks]', error)
    return (data ?? []).map((p: any) => ({
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

    const pickedIds = new Set((picked ?? []).map((p: any) => p.player_id))

    const { data } = await supabase
        .from('players')
        .select('id, display_name, nba_team, position')
        .ilike('display_name', `%${query}%`)
        .order('last_name')
        .limit(20)

    return (data ?? []).filter((p: any) => !pickedIds.has(p.id))
}

// ── API calls ──────────────────────────────────────────────────

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
    if (!json.ok) throw new Error(json.error || 'Backend error')
    return json
}

export async function startRookieDraft(leagueId: string) {
    return apiPost('/draft/start-rookie', { leagueId })
}

export async function makeSnakePick(draftId: string, memberId: string, playerId: string) {
    return apiPost(`/draft/${draftId}/snake-pick`, { memberId, playerId })
}

export async function advanceSeason(leagueId: string) {
    return apiPost('/league/advance-season', { leagueId })
}

// ── Realtime ───────────────────────────────────────────────────

export function subscribeToRookieDraft(draftId: string, onChange: () => void): RealtimeChannel {
    return supabase
        .channel(`rookie-draft:${draftId}`)
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
