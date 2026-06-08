import type { PlayerRow } from '@/lib/players'

export type PlayerSearchSortMode = 'fpts' | 'gamesLeft' | 'name' | 'team' | 'yearsExp'
export type PlayerSearchSortDir = 'asc' | 'desc'

export const PLAYER_SEARCH_SORT_OPTIONS: { key: PlayerSearchSortMode; label: string }[] = [
    { key: 'fpts', label: 'FPts' },
    { key: 'gamesLeft', label: 'G Left' },
    { key: 'name', label: 'Name' },
    { key: 'team', label: 'Team' },
    { key: 'yearsExp', label: 'Exp' },
]

export function sortPlayerSearchResults(
    players: PlayerRow[],
    sortMode: PlayerSearchSortMode,
    sortDir: PlayerSearchSortDir,
    gamesLeft: Map<string, number>,
) {
    return [...players].sort((a, b) => {
        let cmp = 0
        switch (sortMode) {
            case 'fpts':
                cmp = (a.avg_fantasy_points ?? a.avg_points ?? 0) - (b.avg_fantasy_points ?? b.avg_points ?? 0)
                break
            case 'gamesLeft': {
                const ga = gamesLeft.get(a.nba_team ?? '') ?? 0
                const gb = gamesLeft.get(b.nba_team ?? '') ?? 0
                cmp = ga - gb
                break
            }
            case 'name':
                cmp = (a.display_name ?? '').localeCompare(b.display_name ?? '')
                break
            case 'team':
                cmp = (a.nba_team ?? '').localeCompare(b.nba_team ?? '')
                break
            case 'yearsExp':
                cmp = (a.years_exp ?? 99) - (b.years_exp ?? 99)
                break
        }
        return sortDir === 'asc' ? cmp : -cmp
    })
}
