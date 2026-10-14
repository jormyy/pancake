import { getCurrentSeasonId, getLatestSeasonId } from '@/lib/shared/season'
import { getOwnedPlayerMapForSeason, type OwnedEntry } from '@/lib/roster'
import { getWaiverClearsAtForSeason, getPendingWaiverPlayerIdsForSeason } from '@/lib/waivers'
import { getMemberTransactionState, type MemberTransactionState } from '@/lib/league'

export type PlayerAvailabilitySnapshot = {
    leagueId: string | null
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    waiverClearsAt: Map<string, string>
    pendingClaimIds: Set<string>
}

async function getPlayerAvailabilitySnapshot(leagueId: string, memberId?: string): Promise<PlayerAvailabilitySnapshot> {
    const currentSeasonId = await getCurrentSeasonId(leagueId)
    const ownedSeasonId = currentSeasonId ?? await getLatestSeasonId(leagueId)
    if (!ownedSeasonId) return { leagueId, ownedMap: new Map(), waiverIds: new Set(), waiverClearsAt: new Map(), pendingClaimIds: new Set() }

    const [ownedMap, waiverClearsAt, pendingClaimIds] = await Promise.all([
        getOwnedPlayerMapForSeason(leagueId, ownedSeasonId),
        currentSeasonId ? getWaiverClearsAtForSeason(leagueId, currentSeasonId) : Promise.resolve(new Map<string, string>()),
        currentSeasonId && memberId ? getPendingWaiverPlayerIdsForSeason(memberId, currentSeasonId) : Promise.resolve(new Set<string>()),
    ])

    return { leagueId, ownedMap, waiverIds: new Set(waiverClearsAt.keys()), waiverClearsAt, pendingClaimIds }
}

/** Everything the players tab needs before it can render an add button: who owns whom, who is on waivers, and the member's weekly add state. */
export async function loadPlayerSupport(
    memberId: string | undefined,
    leagueId: string,
): Promise<PlayerAvailabilitySnapshot & { transactionState: MemberTransactionState | null }> {
    const [availability, transactionState] = await Promise.all([
        getPlayerAvailabilitySnapshot(leagueId, memberId),
        memberId ? getMemberTransactionState(memberId, leagueId) : Promise.resolve(null),
    ])
    return { ...availability, transactionState }
}
