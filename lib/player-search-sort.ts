// ESPN-style stat sorting: the Players list sorts the ENTIRE filtered pool
// server-side by the chosen stat column, then paginates. These are the columns
// a manager can sort by (every visible stat column on the desktop table).
export type PlayerSearchSortMode = 'dynasty' | 'fpts' | 'min' | 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'tpm' | 'to' | 'gp'
export type PlayerSearchSortDir = 'asc' | 'desc'

export const PLAYER_SEARCH_SORT_OPTIONS: { key: PlayerSearchSortMode; label: string }[] = [
    { key: 'fpts', label: 'Fantasy Pts' },
    { key: 'dynasty', label: 'Dynasty rank' },
    { key: 'min', label: 'Minutes' },
    { key: 'pts', label: 'Points' },
    { key: 'reb', label: 'Rebounds' },
    { key: 'ast', label: 'Assists' },
    { key: 'stl', label: 'Steals' },
    { key: 'blk', label: 'Blocks' },
    { key: 'tpm', label: '3-Pointers' },
    { key: 'to', label: 'Turnovers' },
    { key: 'gp', label: 'Games Played' },
]

// Desktop stat-table column label -> sort mode, so the headers are click-to-sort.
export const STAT_COLUMN_SORT: Record<string, PlayerSearchSortMode> = {
    FP: 'fpts',
    MIN: 'min',
    PTS: 'pts',
    REB: 'reb',
    AST: 'ast',
    STL: 'stl',
    BLK: 'blk',
    '3PM': 'tpm',
    TO: 'to',
    GP: 'gp',
}

export type PlayerSortPreference = { mode: PlayerSearchSortMode; dir: PlayerSearchSortDir }
const preferenceKey = 'pancake-player-sort-v1'
let preference: PlayerSortPreference = { mode: 'fpts', dir: 'desc' }

export function readPlayerSort(): PlayerSortPreference {
    try {
        const value = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null') as PlayerSortPreference | null
        if (value && PLAYER_SEARCH_SORT_OPTIONS.some(option => option.key === value.mode) && (value.dir === 'asc' || value.dir === 'desc')) preference = value
    } catch {}
    return preference
}

export function savePlayerSort(value: PlayerSortPreference): void {
    preference = value
    try { localStorage.setItem(preferenceKey, JSON.stringify(value)) } catch {}
}

export function compareDynastyPlayers(a: { id: string; display_name: string; dynasty_rank?: number | null; avg_fantasy_points?: number | null }, b: typeof a): number {
    const rank = (a.dynasty_rank ?? Infinity) - (b.dynasty_rank ?? Infinity)
    if (rank) return rank
    if (a.dynasty_rank == null && b.dynasty_rank == null) {
        const average = (b.avg_fantasy_points ?? -Infinity) - (a.avg_fantasy_points ?? -Infinity)
        if (average) return average
    }
    return a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id)
}
