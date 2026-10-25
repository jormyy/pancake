import { describe, expect, it } from 'vitest'
import { isTradeableRosterPlayer, isTradeTaxiEligible } from '@/lib/trade-assets'
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
    it('uses one taxi rule and the same player fields as the server', () => {
        const player = { kind: 'player' as const, playerId: 'player', playerName: 'Player', nbaTeam: null, position: 'PG',
            yearsExp: 2, nbaDraftNumber: 12, careerGames: 64 }
        expect(isTradeTaxiEligible(player)).toBe(true)
        expect(isTradeTaxiEligible(player)).toBe(true)
        expect(isTradeTaxiEligible({ ...player, careerGames: 65 })).toBe(false)
        expect(isTradeTaxiEligible({ ...player, yearsExp: 0, nbaDraftNumber: null })).toBe(true)
        expect(isTradeTaxiEligible({ ...player, yearsExp: 0, nbaDraftNumber: null })).toBe(true)
    })

    it('excludes IR and taxi players from trade selection', () => {
        expect(isTradeableRosterPlayer(rosterPlayer())).toBe(true)
        expect(isTradeableRosterPlayer(rosterPlayer({ is_on_ir: true }))).toBe(false)
        expect(isTradeableRosterPlayer(rosterPlayer({ is_on_taxi: true }))).toBe(false)
    })
})
