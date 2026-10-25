import type { OwnedEntry } from '@/lib/roster'
import type {
    PlayerSearchSortDir,
    PlayerSearchSortMode,
} from '@/lib/player-search-sort'

export type PlayerSearchHealthFilter = 'all' | 'healthy' | 'gtd' | 'out' | 'ir'
export type PlayerAvailabilityFilter = 'all' | 'free_agents' | 'waivers' | 'rostered' | 'mine'
export type PlayerPlayingFilter = 'all' | 'today' | 'not_today'

export type PlayerSearchParams = {
    query: string
    position: string
    selectedTeams: string[]
    leagueId: string | null
    playingTeams: string[] | null
    excludedTeams: string[]
    includePlayerIds?: string[]
    excludePlayerIds?: string[]
    rookiesOnly: boolean
    health: PlayerSearchHealthFilter
    sortBy: PlayerSearchSortMode
    sortDir: PlayerSearchSortDir
    // Stats season (averages, fantasy points, projections). Null means automatic season selection.
    seasonYear: number | null
}

type PlayerSearchFilterState = {
    query: string
    position: string
    selectedTeams: string[]
    playingFilter: PlayerPlayingFilter
    availabilityFilter: PlayerAvailabilityFilter
    rookiesOnly: boolean
    health: PlayerSearchHealthFilter
    sortMode: PlayerSearchSortMode
    seasonYear: number | null
}

export const PLAYER_SEARCH_PAGE_SIZE = 20

export const DEFAULT_PLAYER_SEARCH_PARAMS: PlayerSearchParams = {
    query: '',
    position: 'ALL',
    selectedTeams: [],
    leagueId: null,
    playingTeams: null,
    excludedTeams: [],
    rookiesOnly: false,
    health: 'all',
    sortBy: 'fpts',
    sortDir: 'desc',
    seasonYear: null,
}

/** "2025–26" for the season that ends in 2026, the label the player page uses. */
function seasonLabel(seasonYear: number): string {
    return `${seasonYear - 1}–${String(seasonYear).slice(2)}`
}

/** Automatic selection, then the current season and two prior seasons. */
export function playerSeasonFilterOptions(currentSeason: number): { key: string; label: string }[] {
    return [{ key: 'auto', label: 'Auto' }, ...[0, 1, 2].map((back) => ({ key: String(currentSeason - back), label: seasonLabel(currentSeason - back) }))]
}

export function playerAverageLabel(seasonYear: number | null | undefined): string {
    return seasonYear == null ? '' : `${seasonLabel(seasonYear)} avg`
}

function uniqueSorted(values?: string[]): string[] {
    return Array.from(new Set((values ?? []).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

export function availabilityPlayerScope(
    availabilityFilter: PlayerAvailabilityFilter,
    ownedMap: Map<string, OwnedEntry>,
    waiverIds: Set<string>,
    currentMemberId?: string,
): { includePlayerIds?: string[]; excludePlayerIds?: string[] } {
    const ownedIds = uniqueSorted(Array.from(ownedMap.keys()))
    const waiverIdList = uniqueSorted(Array.from(waiverIds))

    switch (availabilityFilter) {
        case 'free_agents':
            return { excludePlayerIds: uniqueSorted([...ownedIds, ...waiverIdList]) }
        case 'waivers':
            return { includePlayerIds: waiverIdList }
        case 'rostered':
            return { includePlayerIds: ownedIds }
        case 'mine':
            return {
                includePlayerIds: uniqueSorted(
                    Array.from(ownedMap.entries())
                        .filter(([, entry]) => entry.memberId === currentMemberId)
                        .map(([playerId]) => playerId),
                ),
            }
        default:
            return {}
    }
}

export function activePlayerFilterCount(state: PlayerSearchFilterState): number {
    let count = 0
    if (state.position !== 'ALL') count++
    if (state.selectedTeams.length > 0) count++
    if (state.playingFilter !== 'all') count++
    if (state.availabilityFilter !== 'free_agents') count++
    if (state.rookiesOnly) count++
    if (state.health !== 'all') count++
    if (state.seasonYear != null) count++
    return count
}

export function playerSearchParamsKey(params: PlayerSearchParams): string {
    return JSON.stringify({
        query: params.query.trim(),
        position: params.position,
        selectedTeams: uniqueSorted(params.selectedTeams),
        leagueId: params.leagueId,
        playingTeams: params.playingTeams == null ? null : uniqueSorted(params.playingTeams),
        excludedTeams: uniqueSorted(params.excludedTeams),
        includePlayerIds: params.includePlayerIds == null ? null : uniqueSorted(params.includePlayerIds),
        excludePlayerIds: uniqueSorted(params.excludePlayerIds),
        rookiesOnly: params.rookiesOnly,
        health: params.health,
        sortBy: params.sortBy,
        sortDir: params.sortDir,
        seasonYear: params.seasonYear,
    })
}
