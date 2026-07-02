import { getCurrentSeasonId, getLatestSeasonId } from '@/lib/shared/season'
import { getOwnedPlayerMapForSeason, type OwnedEntry } from '@/lib/roster'
import { getWaiverPlayerIdsForSeason } from '@/lib/waivers'

export type PlayerAvailabilitySnapshot = {
    leagueId: string | null
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
}

export async function getPlayerAvailabilitySnapshot(leagueId: string): Promise<PlayerAvailabilitySnapshot> {
    const currentSeasonId = await getCurrentSeasonId(leagueId)
    const ownedSeasonId = currentSeasonId ?? await getLatestSeasonId(leagueId)
    if (!ownedSeasonId) return { leagueId, ownedMap: new Map(), waiverIds: new Set() }

    const [ownedMap, waiverIds] = await Promise.all([
        getOwnedPlayerMapForSeason(leagueId, ownedSeasonId),
        currentSeasonId ? getWaiverPlayerIdsForSeason(leagueId, currentSeasonId) : Promise.resolve(new Set<string>()),
    ])

    return { leagueId, ownedMap, waiverIds }
}
