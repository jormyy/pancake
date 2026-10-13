// ESPN-style stat sorting: the Players list sorts the ENTIRE filtered pool
// server-side by the chosen stat column, then paginates. These are the columns
// a manager can sort by (every visible stat column on the desktop table).
export type PlayerSearchSortMode = 'fpts' | 'min' | 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'tpm' | 'to' | 'gp'
export type PlayerSearchSortDir = 'asc' | 'desc'

export const PLAYER_SEARCH_SORT_OPTIONS: { key: PlayerSearchSortMode; label: string }[] = [
    { key: 'fpts', label: 'Fantasy Pts' },
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
