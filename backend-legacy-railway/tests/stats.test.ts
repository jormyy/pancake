import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn() },
    fetchAllPlayers: vi.fn(),
}))

import { buildStatRow } from '../src/sync/stats'
import type { NBABoxScorePlayer } from '../src/lib/nba'

function boxScorePlayer(minutes: string | null | undefined): NBABoxScorePlayer {
    return {
        personId: 1,
        name: 'Short Shift',
        statistics: {
            minutes,
            points: 0,
            reboundsTotal: 0,
            reboundsOffensive: 0,
            reboundsDefensive: 0,
            assists: 0,
            steals: 0,
            blocks: 0,
            turnovers: 0,
            foulsPersonal: 0,
            fieldGoalsMade: 0,
            fieldGoalsAttempted: 0,
            threePointersMade: 0,
            threePointersAttempted: 0,
            freeThrowsMade: 0,
            freeThrowsAttempted: 0,
            plusMinusPoints: 0,
        },
    } as NBABoxScorePlayer
}

describe('buildStatRow', () => {
    it('does not mark short recorded appearances as DNP', () => {
        const row = buildStatRow(boxScorePlayer('PT0M10.00S'), 'player-1', 'game-1', 2027, 1)

        expect(row.minutes_played).toBe(0.17)
        expect(row.did_not_play).toBe(false)
    })

    it('marks missing minutes as DNP', () => {
        const row = buildStatRow(boxScorePlayer(null), 'player-1', 'game-1', 2027, 1)

        expect(row.minutes_played).toBeNull()
        expect(row.did_not_play).toBe(true)
    })
})
