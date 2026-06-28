import { describe, expect, it } from 'vitest'
import { parseNBAScheduleGame } from '../src/lib/nba'

describe('NBA schedule parser', () => {
    it('uses current scheduleLeagueV2 gameDateTime fields for tipoff time', () => {
        const game = parseNBAScheduleGame({
            gameId: '0022500001',
            gameStatus: 1,
            gameDateEst: '2025-10-02T00:00:00Z',
            gameDateTimeUTC: '2025-10-02T16:00:00Z',
            gameDateTimeEst: '2025-10-02T12:00:00Z',
            weekNumber: 2,
            homeTeam: { teamTricode: 'NYK' },
            awayTeam: { teamTricode: 'PHI' },
        })

        expect(game).toEqual({
            gameId: '0022500001',
            gameDate: '2025-10-02',
            homeTeam: 'NYK',
            awayTeam: 'PHI',
            status: 'Scheduled',
            startedAt: '2025-10-02T16:00:00Z',
            weekNumber: 2,
            scheduleSeasonYear: null,
        })
    })

    it('keeps the legacy gameEt fallback', () => {
        const game = parseNBAScheduleGame({
            gameId: '0022500002',
            gameStatus: 3,
            gameEt: '2025-10-03T19:30:00-05:00',
            homeTeam: { teamTricode: 'LAL' },
            awayTeam: { teamTricode: 'BOS' },
        })

        expect(game).toMatchObject({
            gameDate: '2025-10-03',
            status: 'Final',
            startedAt: '2025-10-03T19:30:00-05:00',
            weekNumber: null,
        })
    })
})
