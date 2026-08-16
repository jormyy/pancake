import { describe, expect, it } from 'vitest'
import { sortPlayerRows, PLAYER_SORT_MV_COLUMN, STAT_COLUMN_SORT } from '@/lib/player-search-sort'
import type { PlayerRow } from '@/lib/players'

function player(id: string, avgPoints: number, avgRebounds = 0): PlayerRow {
    return {
        id,
        display_name: id,
        nba_team: 'ATL',
        position: 'PG',
        eligible_positions: ['PG'],
        status: 'Active',
        injury_status: null,
        headshot_url: null,
        nba_id: null,
        years_exp: null,
        avg_points: avgPoints,
        avg_rebounds: avgRebounds,
    }
}

describe('sortPlayerRows', () => {
    const players = [player('low', 5, 1), player('high', 30, 2), player('none', 0, 9), player('mid', 15, 3)]

    it('orders by points descending (highest first)', () => {
        expect(sortPlayerRows(players, 'pts', 'desc').map((p) => p.id)).toEqual(['high', 'mid', 'low', 'none'])
    })

    it('orders by points ascending (lowest first)', () => {
        expect(sortPlayerRows(players, 'pts', 'asc').map((p) => p.id)).toEqual(['none', 'low', 'mid', 'high'])
    })

    it('orders by a different stat (rebounds) independently of points', () => {
        expect(sortPlayerRows(players, 'reb', 'desc').map((p) => p.id)).toEqual(['none', 'mid', 'high', 'low'])
    })

    it('orders by average minutes played', () => {
        const minutesPlayers = players.map((row, index) => ({
            ...row,
            avg_minutes_played: [12, 34, 8, 27][index],
        }))

        expect(sortPlayerRows(minutesPlayers, 'min', 'desc').map((p) => p.id)).toEqual(['high', 'mid', 'low', 'none'])
    })
})

describe('sort column maps', () => {
    it('maps each sort mode to an mv_player_season_averages column', () => {
        expect(PLAYER_SORT_MV_COLUMN.reb).toBe('avg_rebounds')
        expect(PLAYER_SORT_MV_COLUMN.gp).toBe('games_played')
        expect(PLAYER_SORT_MV_COLUMN.tpm).toBe('avg_three_pointers_made')
        expect(PLAYER_SORT_MV_COLUMN.min).toBe('avg_minutes_played')
    })

    it('maps each desktop table header label to a sort mode', () => {
        expect(STAT_COLUMN_SORT['3PM']).toBe('tpm')
        expect(STAT_COLUMN_SORT.FP).toBe('fpts')
        expect(STAT_COLUMN_SORT.MIN).toBe('min')
        expect(STAT_COLUMN_SORT.GP).toBe('gp')
    })
})
