import { describe, expect, it } from 'vitest'
import { liveScoreView } from '../lib/live-score-view'
import type { LiveSnapshot, SavedLiveMatchup } from '@pancake/core'

const now = Date.parse('2026-10-31T23:00:00Z')
const basis = (): SavedLiveMatchup => ({ id: 'other', homeMemberId: 'a', awayMemberId: 'b', homePoints: 100,
    awayPoints: 80, ready: true, finalized: false, players: [{ playerId: 'player', memberId: 'a', nbaId: '10', espnId: '20',
        team: 'BOS', gameId: '0021', savedPoints: 10, savedAt: now - 30000, starter: true }] })
const snapshot = (): LiveSnapshot => ({ version: 1, mode: 'public', date: '2026-10-31', capturedAt: now,
    games: [{ id: '0021', nbaId: '0021', espnId: null, source: 'nba', status: 'InProgress', updatedAt: now,
        home: { team: 'BOS', score: 14, players: [['10',14,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,25,0]] },
        away: { team: 'NYK', score: 9, players: [] } }] })
function home(line = basis()) {
    return { selectedDate: '2026-10-31', matchup: { id: 'other', myMemberId: 'a', opponentMemberId: 'b', myPoints: line.homePoints, opponentPoints: line.awayPoints },
        liveBasis: [line], leagueMatchups: [{ id: 'other', homePoints: line.homePoints, awayPoints: line.awayPoints }],
        todaysGames: [{ id: 'g', nba_game_id: '0021', home_team: 'BOS', away_team: 'NYK', status: 'InProgress' }],
        liveStats: {},
    } as unknown as Parameters<typeof liveScoreView>[0]
}

describe('home and other-team live scores', () => {
    it('uses the same formula for the displayed matchup, other-matchup list, and player line', () => {
        const view = liveScoreView(home(), snapshot(), { points: 1 }, now)
        expect(view.matchup?.myPoints).toBe(104)
        expect(view.leagueMatchups[0].homePoints).toBe(104)
        expect(view.liveStats.player.points).toBe(14)
    })

    it('shows saved scores for stale data, an outage, or the server off switch', () => {
        for (const source of [null, { ...snapshot(), capturedAt: now - 120001 }, { ...snapshot(), mode: 'database' as const, games: [] }]) {
            const view = liveScoreView(home(), source, { points: 1 }, now)
            expect(view.matchup?.myPoints).toBe(100)
            expect(view.delayed).toBe(source?.mode !== 'database')
        }
    })

    it('does not count a delayed final save twice and preserves subsequent official corrections', () => {
        const line = basis(), source = snapshot()
        source.games[0].status = 'Final'
        line.ready = false
        expect(liveScoreView(home(line), source, { points: 1 }, now).matchup?.myPoints).toBe(100)
        line.ready = true
        line.homePoints = 104
        line.players[0].savedPoints = 14
        line.players[0].final = true
        expect(liveScoreView(home(line), source, { points: 1 }, now).matchup?.myPoints).toBe(104)
        line.homePoints = 105
        line.players[0].savedPoints = 15
        expect(liveScoreView(home(line), source, { points: 1 }, now).matchup?.myPoints).toBe(105)
    })

    it('past-day and finalized views remain official when the live route is unavailable', () => {
        const saved = home()
        saved.selectedDate = '2026-10-30'
        saved.liveBasis = []
        expect(liveScoreView(saved, null, { points: 1 }, now).matchup?.myPoints).toBe(100)
        const line = basis()
        line.finalized = true
        expect(liveScoreView(home(line), snapshot(), { points: 100 }, now).matchup?.myPoints).toBe(100)
    })

    it('formats the provider clock for overtime', () => {
        const source = snapshot()
        source.games[0].period = 5
        source.games[0].clock = 'PT03M09.90S'
        expect(liveScoreView(home(), source, { points: 1 }, now).todaysGames[0].game_status_text).toBe('OT1 3:09')
    })

    it('accepts a partial saved screen before its game data arrives', () => {
        const partial = { ...home(), todaysGames: undefined, leagueMatchups: undefined } as unknown as ReturnType<typeof home>
        expect(liveScoreView(partial, null, {}, now).todaysGames).toEqual([])
    })
})
