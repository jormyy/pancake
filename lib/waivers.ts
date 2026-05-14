import { supabase } from '@/lib/supabase'
import { getCurrentSeasonId } from '@/lib/shared/season'
import { apiPost } from '@/lib/shared/api'

export type WaiverEntry = {
    logId: string
    playerId: string
    playerName: string
    position: string | null
    nbaTeam: string | null
    injuryStatus: string | null
    clearsAt: string
    droppedByTeamName: string | null
}

export type WaiverClaim = {
    id: string
    playerId: string
    playerName: string
    dropPlayerId: string | null
    dropPlayerName: string | null
    status: string
    submittedAt: string
    processDate: string
    priorityAtSubmission: number
}

export async function getWaiverEntries(leagueId: string): Promise<WaiverEntry[]> {
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) return []

    const now = new Date().toISOString()
    const { data, error } = await supabase
        .from('waiver_wire_log')
        .select(`
            id,
            player_id,
            clears_at,
            players ( display_name, position, nba_team, injury_status ),
            dropped_by:league_members!waiver_wire_log_dropped_by_member_id_fkey ( team_name )
        `)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .is('cleared_at', null)
        .gt('clears_at', now)
        .order('clears_at', { ascending: true })

    if (error) throw error

    return (data ?? []).map((row: any) => ({
        logId: row.id,
        playerId: row.player_id,
        playerName: row.players?.display_name ?? 'Unknown',
        position: row.players?.position ?? null,
        nbaTeam: row.players?.nba_team ?? null,
        injuryStatus: row.players?.injury_status ?? null,
        clearsAt: row.clears_at,
        droppedByTeamName: row.dropped_by?.team_name ?? null,
    }))
}

export async function getWaiverPlayerIds(leagueId: string): Promise<Set<string>> {
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) return new Set()

    const now = new Date().toISOString()
    const { data, error } = await supabase
        .from('waiver_wire_log')
        .select('player_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .is('cleared_at', null)
        .gt('clears_at', now)

    if (error) throw error
    return new Set((data ?? []).map((r: any) => r.player_id))
}

export async function submitWaiverClaim(
    memberId: string,
    leagueId: string,
    playerId: string,
    dropPlayerId?: string,
): Promise<void> {
    await apiPost('/waivers/claims', {
        memberId,
        leagueId,
        playerId,
        dropPlayerId: dropPlayerId ?? null,
    })
}

export async function cancelWaiverClaim(claimId: string, memberId: string): Promise<void> {
    await apiPost(`/waivers/claims/${claimId}/cancel`, { memberId })
}

export async function getMyWaiverClaims(
    memberId: string,
    leagueId: string,
): Promise<WaiverClaim[]> {
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) return []

    const { data, error } = await supabase
        .from('waiver_claims')
        .select(`
            id,
            player_id,
            drop_player_id,
            status,
            submitted_at,
            process_date,
            priority_at_submission,
            claim_player:players!waiver_claims_player_id_fkey ( display_name ),
            drop_player:players!waiver_claims_drop_player_id_fkey ( display_name )
        `)
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
        .in('status', ['pending', 'succeeded', 'failed_priority', 'failed_roster'])
        .order('submitted_at', { ascending: false })
        .limit(20)

    if (error) throw error

    return (data ?? []).map((row: any) => ({
        id: row.id,
        playerId: row.player_id,
        playerName: row.claim_player?.display_name ?? 'Unknown',
        dropPlayerId: row.drop_player_id ?? null,
        dropPlayerName: row.drop_player?.display_name ?? null,
        status: row.status,
        submittedAt: row.submitted_at,
        processDate: row.process_date,
        priorityAtSubmission: row.priority_at_submission,
    }))
}

export type WaiverPriorityRow = {
    memberId: string
    teamName: string
    displayName: string
    priority: number
}

export async function getWaiverPriorityOrder(leagueId: string): Promise<WaiverPriorityRow[]> {
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) return []

    const { data, error } = await supabase
        .from('waiver_priorities')
        .select(`
            priority,
            member_id,
            league_members!waiver_priorities_member_id_fkey (
                team_name,
                profiles ( display_name, username )
            )
        `)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .order('priority', { ascending: true })

    if (error) throw error

    return (data ?? []).map((row: any) => {
        const member = row.league_members
        const profile = member?.profiles
        return {
            memberId: row.member_id,
            teamName: member?.team_name ?? 'Unknown',
            displayName: profile?.display_name ?? profile?.username ?? '—',
            priority: row.priority,
        }
    })
}

export async function getMyWaiverPriority(
    memberId: string,
    leagueId: string,
): Promise<number | null> {
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) return null

    const { data, error } = await supabase
        .from('waiver_priorities')
        .select('priority')
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
        .single()
    if (error) return null
    return data?.priority ?? null
}
