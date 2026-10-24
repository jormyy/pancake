import { assertReadActive } from '@/lib/shared/read-admission'
import { getCurrentSeasonId, getLatestSeasonId } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'
import { getOwnedPlayerMapForSeason, type RosterOccupancy, type OwnedEntry } from '@/lib/roster'
import { getWaiverClearsAtForSeason, getPendingWaiverPlayerIdsForSeason } from '@/lib/waivers'
import { getMemberTransactionState, type MemberTransactionState } from '@/lib/league'

type PlayerAvailabilitySnapshot = {
    leagueId: string | null
    seasonId: string | null
    memberId: string | null
    day: string
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    waiverClearsAt: Map<string, string>
    pendingClaimIds: Set<string>
}
export type PlayerSupport = PlayerAvailabilitySnapshot & { transactionState: MemberTransactionState | null; roster?: RosterOccupancy[] }
export type PlayerSupportResource = 'ownership' | 'waivers' | 'claims' | 'transactions'

export async function loadPlayerSupport(
    memberId: string | undefined,
    leagueId: string,
    options: { previous?: PlayerSupport | null; resources?: readonly PlayerSupportResource[]; canRead?: () => boolean } = {},
): Promise<PlayerSupport> {
    assertReadActive(options.canRead)
    const currentSeasonId = await getCurrentSeasonId(leagueId)
    assertReadActive(options.canRead)
    const seasonId = currentSeasonId ?? await getLatestSeasonId(leagueId)
    assertReadActive(options.canRead)
    const day = todayET()
    const previous = options.previous
    const reuse = previous?.leagueId === leagueId && previous.seasonId === seasonId
        && previous.memberId === (memberId ?? null) && previous.day === day
    const changed = new Set(options.resources)
    const needs = (resource: PlayerSupportResource) => !reuse || !options.resources || changed.has(resource)
    const [ownedMap, waiverClearsAt, pendingClaimIds, transactionState] = await Promise.all([
        needs('ownership') ? (seasonId ? getOwnedPlayerMapForSeason(leagueId, seasonId) : new Map<string, OwnedEntry>()) : previous!.ownedMap,
        needs('waivers') ? (currentSeasonId ? getWaiverClearsAtForSeason(leagueId, currentSeasonId) : new Map<string, string>()) : previous!.waiverClearsAt,
        needs('claims') ? (currentSeasonId && memberId ? getPendingWaiverPlayerIdsForSeason(memberId, currentSeasonId) : new Set<string>()) : previous!.pendingClaimIds,
        needs('transactions') ? (memberId ? getMemberTransactionState(memberId, leagueId) : null) : previous!.transactionState,
    ])
    const roster = needs('ownership')
        ? [...ownedMap.values()].filter(entry => entry.memberId === memberId).map(entry => ({ is_on_ir: entry.isOnIR ?? false }))
        : previous?.roster ?? []
    return { leagueId, seasonId, memberId: memberId ?? null, day, ownedMap, waiverIds: new Set(waiverClearsAt.keys()), waiverClearsAt, pendingClaimIds, transactionState, roster }
}
