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
    bidAmount: number
    claimOrder: number
    failureReason: string | null
}

type PlayerSummaryRow = {
    display_name: string | null
    position?: string | null
    nba_team?: string | null
    injury_status?: string | null
} | null
type TeamNameRow = { team_name: string | null } | null
type WaiverEntryQueryRow = {
    id: string
    player_id: string
    clears_at: string
    players: PlayerSummaryRow
    dropped_by: TeamNameRow
}
type WaiverPlayerIdRow = { player_id: string }
type WaiverClaimQueryRow = {
    id: string
    player_id: string
    drop_player_id: string | null
    status: string
    submitted_at: string
    process_date: string
    priority_at_submission: number
    bid_amount: number
    claim_order: number
    failure_reason: string | null
    claim_player: PlayerSummaryRow
    drop_player: PlayerSummaryRow
}
type PriorityMemberRow = {
    team_name: string | null
    profiles: { display_name: string | null; username: string | null } | null
} | null
type WaiverPriorityQueryRow = {
    priority: number
    member_id: string
    league_members: PriorityMemberRow
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

    return ((data ?? []) as WaiverEntryQueryRow[]).map((row) => ({
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

export async function getWaiverPlayerIdsForSeason(leagueId: string, seasonId: string): Promise<Set<string>> {
    const now = new Date().toISOString()
    const { data: activeLogs, error } = await supabase
        .from('waiver_wire_log')
        .select('player_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .is('cleared_at', null)
        .gt('clears_at', now)

    if (error) throw error

    const playerIds = new Set(((activeLogs ?? []) as WaiverPlayerIdRow[]).map((row) => row.player_id))

    return playerIds
}

export async function getWaiverPlayerIds(leagueId: string): Promise<Set<string>> {
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) return new Set()
    return getWaiverPlayerIdsForSeason(leagueId, seasonId)
}

export async function submitWaiverClaim(
    memberId: string,
    leagueId: string,
    playerId: string,
    dropPlayerId?: string,
    options: { bidAmount?: number; claimOrder?: number | null } = {},
): Promise<void> {
    await apiPost('/waivers/claims', {
        memberId,
        leagueId,
        playerId,
        dropPlayerId: dropPlayerId ?? null,
        bidAmount: options.bidAmount ?? 0,
        claimOrder: options.claimOrder ?? null,
    })
}

export async function cancelWaiverClaim(claimId: string, memberId: string): Promise<void> {
    await apiPost(`/waivers/claims/${claimId}/cancel`, { memberId })
}

export async function editWaiverClaim(
    claimId: string,
    memberId: string,
    updates: { dropPlayerId?: string | null; bidAmount?: number; claimOrder?: number | null },
): Promise<void> {
    await apiPost(`/waivers/claims/${claimId}/edit`, {
        memberId,
        dropPlayerId: updates.dropPlayerId ?? null,
        bidAmount: updates.bidAmount ?? 0,
        claimOrder: updates.claimOrder ?? null,
    })
}

export async function reorderWaiverClaim(
    claimId: string,
    memberId: string,
    direction: 'up' | 'down',
): Promise<number> {
    const result = await apiPost<{ claimOrder: number }>(`/waivers/claims/${claimId}/reorder`, {
        memberId,
        direction,
    })
    return result.claimOrder
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
            bid_amount,
            claim_order,
            failure_reason,
            claim_player:players!waiver_claims_player_id_fkey ( display_name ),
            drop_player:players!waiver_claims_drop_player_id_fkey ( display_name )
        `)
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
        .in('status', ['pending', 'succeeded', 'failed_priority', 'failed_roster'])
        .order('claim_order', { ascending: true })
        .order('submitted_at', { ascending: false })
        .limit(20)

    if (error) throw error

    return ((data ?? []) as WaiverClaimQueryRow[]).map((row) => ({
        id: row.id,
        playerId: row.player_id,
        playerName: row.claim_player?.display_name ?? 'Unknown',
        dropPlayerId: row.drop_player_id ?? null,
        dropPlayerName: row.drop_player?.display_name ?? null,
        status: row.status,
        submittedAt: row.submitted_at,
        processDate: row.process_date,
        priorityAtSubmission: row.priority_at_submission,
        bidAmount: row.bid_amount ?? 0,
        claimOrder: row.claim_order ?? 1,
        failureReason: row.failure_reason ?? null,
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

    return ((data ?? []) as WaiverPriorityQueryRow[]).map((row) => {
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
