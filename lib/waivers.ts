import { formatLeagueTime, resolveLeagueTimezone, startOfLeagueDayUTC, todayLeague } from '@/lib/timezone'
import { assertMutationOnline } from '@/lib/shared/pwa-mutation'
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

export async function submitWaiverClaim(
    memberId: string,
    leagueId: string,
    playerId: string,
    dropPlayerId?: string,
    options: { bidAmount?: number; claimOrder?: number | null; toIr?: boolean; toTaxi?: boolean } = {},
): Promise<void> {
    assertMutationOnline()
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

export type WaiverPriorityRow = {
    memberId: string
    teamName: string
    displayName: string
    priority: number
}

export function claimRunAt(clearsAt: string | null, now: Date = new Date(), timezone?: string | null): Date {
    const threshold = new Date(Math.max(now.getTime(), clearsAt ? Date.parse(clearsAt) || now.getTime() : now.getTime()))
    const day = todayLeague(timezone, threshold)
    const run = startOfLeagueDayUTC(day, timezone)
    if (run.getTime() > now.getTime() && run.getTime() >= threshold.getTime()) return run
    const nextDay = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    return startOfLeagueDayUTC(nextDay, timezone)
}

export function claimProcessDateLabel(clearsAt: string | null, now: Date = new Date(), timezone?: string | null): string {
    return scheduledClaimLabel(todayLeague(timezone, claimRunAt(clearsAt, now, timezone)), timezone)
}

export function claimProcessWeekdayLabel(clearsAt: string | null, now: Date = new Date(), timezone?: string | null): string {
    return claimRunAt(clearsAt, now, timezone).toLocaleDateString('en-US', { weekday: 'short', timeZone: resolveLeagueTimezone(timezone) })
}

export function claimProcessTimeLabel(clearsAt: string | null, now: Date = new Date(), timezone?: string | null): string {
    return `${claimProcessWeekdayLabel(clearsAt, now, timezone)} ${formatLeagueTime(claimRunAt(clearsAt, now, timezone), resolveLeagueTimezone(timezone))}`
}

export function scheduledClaimLabel(processDate: string, timezone?: string | null): string {
    const date = scheduledClaimRunAt(processDate, timezone)
    return `${date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: resolveLeagueTimezone(timezone) })} · ${formatLeagueTime(date, resolveLeagueTimezone(timezone))}`
}

export function scheduledClaimRunAt(processDate: string, timezone?: string | null): Date {
    return startOfLeagueDayUTC(processDate, timezone)
}
