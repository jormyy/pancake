import type { PlayerRow } from '@/lib/players'

// ESPN-style stat sorting: the Players list sorts the ENTIRE filtered pool
// server-side by the chosen stat column, then paginates. These are the columns
// a manager can sort by (every visible stat column on the desktop table).
export type PlayerSearchSortMode = 'fpts' | 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'tpm' | 'to' | 'gp'
export type PlayerSearchSortDir = 'asc' | 'desc'

export const PLAYER_SEARCH_SORT_OPTIONS: { key: PlayerSearchSortMode; label: string }[] = [
    { key: 'fpts', label: 'Fantasy Pts' },
    { key: 'pts', label: 'Points' },
    { key: 'reb', label: 'Rebounds' },
    { key: 'ast', label: 'Assists' },
    { key: 'stl', label: 'Steals' },
    { key: 'blk', label: 'Blocks' },
    { key: 'tpm', label: '3-Pointers' },
    { key: 'to', label: 'Turnovers' },
    { key: 'gp', label: 'Games Played' },
]

// The orderable column on mv_player_season_averages for each sort mode. 'fpts'
// maps to avg_points here only as the no-league proxy; league fpts ordering
// uses v_player_avg_fantasy_points.avg_fantasy_points (handled in searchPlayers).
export const PLAYER_SORT_MV_COLUMN: Record<PlayerSearchSortMode, string> = {
    fpts: 'avg_points',
    pts: 'avg_points',
    reb: 'avg_rebounds',
    ast: 'avg_assists',
    stl: 'avg_steals',
    blk: 'avg_blocks',
    tpm: 'avg_three_pointers_made',
    to: 'avg_turnovers',
    gp: 'games_played',
}

// Desktop stat-table column label -> sort mode, so the headers are click-to-sort.
export const STAT_COLUMN_SORT: Record<string, PlayerSearchSortMode> = {
    FP: 'fpts',
    PTS: 'pts',
    REB: 'reb',
    AST: 'ast',
    STL: 'stl',
    BLK: 'blk',
    '3PM': 'tpm',
    TO: 'to',
    GP: 'gp',
}

function statValue(player: PlayerRow, mode: PlayerSearchSortMode): number {
    switch (mode) {
        case 'fpts': return player.avg_fantasy_points ?? player.avg_points ?? 0
        case 'pts': return player.avg_points ?? 0
        case 'reb': return player.avg_rebounds ?? 0
        case 'ast': return player.avg_assists ?? 0
        case 'stl': return player.avg_steals ?? 0
        case 'blk': return player.avg_blocks ?? 0
        case 'tpm': return player.avg_three_pointers_made ?? 0
        case 'to': return player.avg_turnovers ?? 0
        case 'gp': return player.games_played ?? 0
    }
}

// Pure stat sort over an in-memory PlayerRow set. The Players list sorts the
// full pool server-side, so this is used only where the result set is already
// complete (the rookies-only branch returns every rookie, unpaginated).
export function sortPlayerRows(
    players: PlayerRow[],
    mode: PlayerSearchSortMode,
    dir: PlayerSearchSortDir,
): PlayerRow[] {
    return [...players].sort((a, b) => {
        const cmp = statValue(a, mode) - statValue(b, mode)
        return dir === 'asc' ? cmp : -cmp
    })
}
