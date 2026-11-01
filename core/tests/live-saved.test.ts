import { describe, expect, it } from 'vitest'
import { decodeSavedLiveView } from '../src/live/saved'
import { overlayLiveScores } from '../src/live/overlay'

describe('compact saved live scores', () => {
    it('restores every score input and preserves official final handoff', () => {
        const value = { liveBasis: [['m', 'a', 'b', 10, 4, false, true, [['p', 0, '1', null, 'BOS', '0021', 10, 0, true, false]]]] }
        const decoded = decodeSavedLiveView(value) as unknown as { liveBasis: Parameters<typeof overlayLiveScores>[0] }
        expect(decoded.liveBasis[0].players[0]).toEqual({ playerId: 'p', memberId: 'a', nbaId: '1', espnId: null, team: 'BOS',
            gameId: '0021', savedPoints: 10, savedAt: 0, starter: true, final: false })
        expect(overlayLiveScores(decoded.liveBasis, { version: 1, mode: 'public', date: '2026-11-01', capturedAt: 100,
            games: [{ id: '0021', nbaId: '0021', espnId: null, status: 'Final', updatedAt: 100,
                home: { team: 'BOS', score: 12, players: [['1', 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25, 0]] },
                away: { team: 'NYK', score: 0, players: [] } }] }, { points: 1 }, 100).matchups[0].homePoints).toBe(12)
    })
    it('retains the old view format and rejects malformed compact values', () => {
        const value = { liveBasis: [{ id: 'm' }] }
        expect(decodeSavedLiveView(value)).toBe(value)
        expect(() => decodeSavedLiveView({ liveBasis: [['broken']] })).toThrow('Invalid saved live matchup')
        expect(() => decodeSavedLiveView({ liveBasis: [['m', 'a', 'b', 10, 4, 'false', true, []]] })).toThrow('Invalid saved live flag')
        expect(() => decodeSavedLiveView({ wireVersion: 2 })).toThrow('Unsupported compact Home version')
    })
    it('restores the displayed lineup and box-score fields', () => {
        const player = ['r', 'p', 'Player', 'PG', ['PG'], 'BOS', 3, 10, null, '1', '2', []]
        const line = [12, 3, 4, 1, 0, 2, 2, 4, 10, 2, 2, 1, false, false, 20, false]
        const value = decodeSavedLiveView({ wireVersion: 1, liveBasis: [], myLineup: { starters: [['PG', player]], bench: [], ir: [], taxi: [] },
            oppLineup: null, liveStats: { p: line } }) as unknown as {
                myLineup: { starters: unknown[] }; liveStats: Record<string, unknown>; wireVersion?: number
            }
        expect(value.myLineup.starters[0]).toEqual({ slotType: 'PG', player: { rosterPlayerId: 'r', playerId: 'p', displayName: 'Player',
            position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'BOS', yearsExp: 3, careerGames: 10, injuryStatus: null, nbaId: '1', espnId: '2', assetLocks: [] } })
        expect(value.liveStats.p).toMatchObject({ points: 12, rebounds: 3, minutesPlayed: 20, didNotPlay: false, doubleDouble: false })
        expect(value.wireVersion).toBeUndefined()
    })
})
