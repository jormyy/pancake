import { assertReadActive } from '@/lib/shared/read-admission'
import { supabase } from '@/lib/supabase'
import { getCurrentSeasonId } from '@/lib/shared/season'
import { apiPost } from '@/lib/shared/api'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { notifyMemberClaimsChanged } from '@/lib/claim-updates'

export type WaiverClaim = {
    id: string
    playerId: string
    playerName: string
    playerNbaId: string | null
    dropPlayerId: string | null
    dropPlayerName: string | null
    dropPlayerNbaId: string | null
    status: string
    submittedAt: string
    processDate: string
    priorityAtSubmission: number
    bidAmount: number
    claimOrder: number
    clearsAt?: string | null
    toIr?: boolean
    toTaxi?: boolean
    playerTeam?: string | null
    playerPosition?: string | null
    playerInjuryStatus?: string | null
    playerYearsExp?: number | null
    playerCareerGames?: number | null
    failureReason: string | null
}

type PlayerSummaryRow = {
    display_name: string | null
    nba_id?: string | null
    position?: string | null
    nba_team?: string | null
    injury_status?: string | null
    years_exp?: number | null
    career_regular_season_games?: number | null
} | null
type WaiverPlayerIdRow = { player_id: string; clears_at: string }
type WaiverClaimQueryRow = {
    to_ir: boolean
    to_taxi: boolean
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

export async function getWaiverClearsAtForSeason(leagueId: string, seasonId: string, playerIds?: string[]): Promise<Map<string, string>> {
    const now = new Date().toISOString()
    let query = supabase
        .from('waiver_wire_log')
        .select('player_id, clears_at')
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .is('cleared_at', null)
        .gt('clears_at', now)

    if (playerIds) query = query.in('player_id', playerIds)
    const { data: activeLogs, error } = await query
    if (error) throw error
    const clearsAt = new Map<string, string>()
    for (const row of (activeLogs ?? []) as WaiverPlayerIdRow[]) {
        const previous = clearsAt.get(row.player_id)
        if (!previous || row.clears_at > previous) clearsAt.set(row.player_id, row.clears_at)
    }
    return clearsAt

}

export async function getPendingWaiverPlayerIdsForSeason(memberId: string, seasonId: string): Promise<Set<string>> {
    const { data, error } = await supabase.from('waiver_claims').select('player_id')
        .eq('member_id', memberId).eq('league_season_id', seasonId).eq('status', 'pending')
    if (error) throw error
    return new Set((data ?? []).map((row) => row.player_id))
}

export async function submitWaiverClaim(
    memberId: string,
    leagueId: string,
    playerId: string,
    dropPlayerId?: string,
    options: { bidAmount?: number; claimOrder?: number | null; toIr?: boolean; toTaxi?: boolean } = {},
): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('Connect to the internet to submit a waiver claim.')
    }
    const generation = sessionGeneration()
    await apiPost('/waivers/claims', {
        memberId,
        leagueId,
        playerId,
        dropPlayerId: dropPlayerId ?? null,
        bidAmount: options.bidAmount ?? 0,
        claimOrder: options.claimOrder ?? null,
        toIr: options.toIr ?? false,
        toTaxi: options.toTaxi ?? false,
    })
    if (generation === sessionGeneration()) notifyMemberClaimsChanged(memberId)
}

export async function cancelWaiverClaim(claimId: string, memberId: string): Promise<void> {
    const generation = sessionGeneration()
    await apiPost(`/waivers/claims/${claimId}/cancel`, { memberId })
    if (generation === sessionGeneration()) notifyMemberClaimsChanged(memberId)
}

export async function editWaiverClaim(
    claimId: string,
    memberId: string,
    // dropPlayerId is required (null clears it): edit_waiver_claim_atomic writes
    // whatever it receives, so an omitted field would silently drop the drop
    // player and turn a valid claim into one that fails "roster full".
    updates: { dropPlayerId: string | null; bidAmount?: number; claimOrder?: number | null; toIr?: boolean; toTaxi?: boolean },
): Promise<void> {
    const generation = sessionGeneration()
    await apiPost(`/waivers/claims/${claimId}/edit`, {
        memberId,
        dropPlayerId: updates.dropPlayerId,
        bidAmount: updates.bidAmount ?? 0,
        claimOrder: updates.claimOrder ?? null,
        ...(updates.toIr !== undefined ? { toIr: updates.toIr } : {}),
        ...(updates.toTaxi !== undefined ? { toTaxi: updates.toTaxi } : {}),
    })
    if (generation === sessionGeneration()) notifyMemberClaimsChanged(memberId)
}

export async function reorderWaiverClaim(
    claimId: string,
    memberId: string,
    direction: 'up' | 'down',
): Promise<number> {
    const generation = sessionGeneration()
    const result = await apiPost<{ claimOrder: number }>(`/waivers/claims/${claimId}/reorder`, {
        memberId,
        direction,
    })
    if (generation === sessionGeneration()) notifyMemberClaimsChanged(memberId)
    return result.claimOrder
}

export async function getMyWaiverClaims(
    memberId: string,
    leagueId: string,
): Promise<WaiverClaim[]> {
    const seasonId = await getCurrentSeasonId(leagueId)
    if (!seasonId) return []

    const claimsQuery = () => supabase
        .from('waiver_claims')
        .select<string, WaiverClaimQueryRow>(`
            id,
            player_id,
            drop_player_id,
            status,
            submitted_at,
            process_date,
            priority_at_submission,
            bid_amount,
            claim_order,
            to_ir,
            to_taxi,
            failure_reason,
            claim_player:players!waiver_claims_player_id_fkey ( display_name, nba_id, nba_team, position, injury_status, years_exp, career_regular_season_games ),
            drop_player:players!waiver_claims_drop_player_id_fkey ( display_name, nba_id )
        `)
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
    const [pending, resolved] = await Promise.all([
        claimsQuery().eq('status', 'pending')
            .order('claim_order', { ascending: true })
            .order('submitted_at', { ascending: true }),
        claimsQuery().in('status', ['succeeded', 'failed_priority', 'failed_roster'])
            .order('submitted_at', { ascending: false }).limit(20),
    ])
    if (pending.error) throw pending.error
    if (resolved.error) throw resolved.error
    const data = [...(pending.data ?? []), ...(resolved.data ?? [])] as WaiverClaimQueryRow[]
    const pendingPlayerIds = (pending.data ?? []).map(row => row.player_id)
    const clearsAt = pendingPlayerIds.length ? await getWaiverClearsAtForSeason(leagueId, seasonId, pendingPlayerIds) : new Map<string, string>()
    return data.map((row) => ({
        id: row.id,
        playerId: row.player_id,
        clearsAt: clearsAt.get(row.player_id) ?? null,
        playerName: row.claim_player?.display_name ?? 'Unknown',
        playerNbaId: row.claim_player?.nba_id ?? null,
        dropPlayerId: row.drop_player_id ?? null,
        dropPlayerName: row.drop_player?.display_name ?? null,
        dropPlayerNbaId: row.drop_player?.nba_id ?? null,
        status: row.status,
        submittedAt: row.submitted_at,
        processDate: row.process_date,
        priorityAtSubmission: row.priority_at_submission,
        bidAmount: row.bid_amount ?? 0,
        claimOrder: row.claim_order ?? 1,
        toIr: row.to_ir,
        toTaxi: row.to_taxi,
        playerTeam: row.claim_player?.nba_team ?? null,
        playerPosition: row.claim_player?.position ?? null,
        playerInjuryStatus: row.claim_player?.injury_status ?? null,
        playerYearsExp: row.claim_player?.years_exp ?? null,
        playerCareerGames: row.claim_player?.career_regular_season_games ?? null,
        failureReason: row.failure_reason ?? null,
    }))
}

export type WaiverPriorityRow = {
    memberId: string
    teamName: string
    displayName: string
    priority: number
}

export async function getWaiverPriorityOrder(leagueId: string, canRead?: () => boolean): Promise<WaiverPriorityRow[]> {
    assertReadActive(canRead)
    const seasonId = await getCurrentSeasonId(leagueId)
    assertReadActive(canRead)
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
        .maybeSingle()
    if (error) throw error
    return data?.priority ?? null
}

/** When this player's current waiver period ends, or null if they aren't on waivers. */
export async function getWaiverClearsAt(leagueId: string, playerId: string): Promise<string | null> {
    const { data, error } = await supabase
        .from('waiver_wire_log')
        .select('clears_at')
        .eq('league_id', leagueId)
        .eq('player_id', playerId)
        .is('cleared_at', null)
        .gt('clears_at', new Date().toISOString())
        .order('clears_at', { ascending: false })
        .limit(1)
    if (error) throw error
    return (data?.[0] as { clears_at: string } | undefined)?.clears_at ?? null
}

const waiverTimeZone = 'America/New_York'
const waiverHour = new Intl.DateTimeFormat('en-US', { timeZone: waiverTimeZone, hour: '2-digit', hourCycle: 'h23' })

export function claimRunAt(clearsAt: string | null, now: Date = new Date()): Date {
    const threshold = new Date(Math.max(now.getTime(), clearsAt ? Date.parse(clearsAt) || now.getTime() : now.getTime()))
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: waiverTimeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(threshold)
    const part = (type: string) => Number(parts.find((value) => value.type === type)?.value)
    const day = Date.UTC(part('year'), part('month') - 1, part('day'))
    const runOnDay = (date: number) => {
        const early = new Date(date + 7 * 60 * 60 * 1000)
        return waiverHour.format(early) === '03' ? early : new Date(date + 8 * 60 * 60 * 1000)
    }
    const run = runOnDay(day)
    return run.getTime() >= threshold.getTime() ? run : runOnDay(day + 24 * 60 * 60 * 1000)
}

export function claimProcessDateLabel(clearsAt: string | null, now: Date = new Date()): string {
    return `${claimRunAt(clearsAt, now).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: waiverTimeZone })} · 3 AM ET`
}

export function claimProcessWeekdayLabel(clearsAt: string | null, now: Date = new Date()): string {
    return claimRunAt(clearsAt, now).toLocaleDateString('en-US', { weekday: 'short', timeZone: waiverTimeZone })
}

export function claimProcessTimeLabel(clearsAt: string | null, now: Date = new Date()): string {
    return `${claimProcessWeekdayLabel(clearsAt, now)} 3 AM ET`
}
