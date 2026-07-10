import { describe, expect, it } from 'vitest'
import { isTradeableRosterPlayer } from '@/lib/trade-assets'
import type { RosterPlayer } from '@/lib/roster'

function rosterPlayer(overrides: Partial<RosterPlayer> = {}): RosterPlayer {
    return {
        id: 'roster-player',
        is_on_ir: false,
        is_on_taxi: false,
        acquired_via: 'draft',
        players: {
            id: 'player',
            display_name: 'Player',
            nba_team: null,
            position: 'PG',
            eligible_positions: ['PG'],
            injury_status: null,
            nba_id: null,
            nba_draft_number: null,
            years_exp: null,
        },
        ...overrides,
    }
}

describe('tradeable roster assets', () => {
    it('excludes IR and taxi players from trade selection', () => {
        expect(isTradeableRosterPlayer(rosterPlayer())).toBe(true)
        expect(isTradeableRosterPlayer(rosterPlayer({ is_on_ir: true }))).toBe(false)
        expect(isTradeableRosterPlayer(rosterPlayer({ is_on_taxi: true }))).toBe(false)
    })
})
