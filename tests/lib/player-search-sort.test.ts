import { describe, expect, it } from 'vitest'
import { sortPlayerSearchResults } from '@/lib/player-search-sort'
import type { PlayerRow } from '@/lib/players'

function player(id: string, team: string, displayName = id): PlayerRow {
    return {
        id,
        display_name: displayName,
        nba_team: team,
        position: 'PG',
        eligible_positions: ['PG'],
        status: 'Active',
        injury_status: null,
        headshot_url: null,
        nba_id: null,
        years_exp: null,
    }
}

describe('sortPlayerSearchResults', () => {
    const players = [
        player('low', 'ATL'),
        player('high', 'DEN'),
        player('none', 'FA'),
        player('mid', 'LAL'),
    ]
    const gamesLeft = new Map([
        ['ATL', 1],
        ['DEN', 3],
        ['LAL', 2],
    ])

    it('orders G Left descending with the most games first', () => {
        const sorted = sortPlayerSearchResults(players, 'gamesLeft', 'desc', gamesLeft)
        expect(sorted.map((item) => item.id)).toEqual(['high', 'mid', 'low', 'none'])
    })

    it('orders G Left ascending with the fewest games first', () => {
        const sorted = sortPlayerSearchResults(players, 'gamesLeft', 'asc', gamesLeft)
        expect(sorted.map((item) => item.id)).toEqual(['none', 'low', 'mid', 'high'])
    })
})
