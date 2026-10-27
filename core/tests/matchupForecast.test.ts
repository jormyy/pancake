import { describe, expect, it } from 'vitest'
import { estimateMatchup, sampleScoringVariation, type ForecastGame } from '../src/forecast/matchup'

const scores = [{ memberId: 'home', currentPoints: 100 }, { memberId: 'away', currentPoints: 95 }]
const game = (changes: Partial<ForecastGame> = {}): ForecastGame => ({
    gameId: 'g1', playerId: 'p1', memberId: 'home', expectedPoints: 20, variance: 25, completed: false, eligible: true, ...changes,
})

describe('matchup forecasts', () => {
    it('adds only remaining eligible games and uses independently known normal probabilities', () => {
        const result = estimateMatchup(scores, [
            game(),
            game({ gameId: 'g2', completed: true, expectedPoints: 900 }),
            game({ playerId: 'p2', eligible: false, expectedPoints: 900 }),
            game({ playerId: 'p3', memberId: 'away', expectedPoints: 20, variance: 0 }),
        ])
        expect(result.teams.map(team => team.projectedFinal)).toEqual([120, 115])
        expect(result.teams.map(team => team.remainingGames)).toEqual([1, 1])
        expect(result.teams[0].winProbability).toBeCloseTo(0.841344746, 6)
        expect(result.teams[1].winProbability).toBeCloseTo(0.158655254, 6)
    })

    it('keeps equal inputs stable and reverses participant probabilities', () => {
        const games = [game(), game({ playerId: 'p2', memberId: 'away', expectedPoints: 18 })]
        const original = estimateMatchup(scores, games)
        expect(estimateMatchup(scores, games)).toEqual(original)
        expect(estimateMatchup([...scores].reverse(), [...games].reverse()).teams).toEqual([...original.teams].reverse())
    })

    it('does not replace missing projection or variance with invented certainty', () => {
        const missing = estimateMatchup(scores, [game({ expectedPoints: null }), game({ playerId: 'p2', variance: null })])
        expect(missing.status).toBe('limited')
        expect(missing.teams[0].projectedFinal).toBeNull()
        expect(missing.teams.every(team => team.winProbability === null)).toBe(true)
        expect(missing.missingInputs).toHaveLength(2)
        expect(estimateMatchup(scores, [], ['Schedule unavailable']).teams[0].winProbability).toBeNull()
    })

    it('handles final winners, ties, and negative fantasy points', () => {
        expect(estimateMatchup(scores, []).teams.map(team => team.winProbability)).toEqual([1, 0])
        const tie = estimateMatchup([{ memberId: 'home', currentPoints: -5 }, { memberId: 'away', currentPoints: -5 }], [])
        expect(tie.teams.map(team => team.winProbability)).toEqual([0, 0])
        expect(tie.tieProbability).toBe(1)
        expect(estimateMatchup(scores, [game({ expectedPoints: -10, variance: 0 })]).teams[0].winProbability).toBe(0)
    })

    it('rejects duplicate ownership, duplicate games, and nonfinite inputs', () => {
        expect(() => estimateMatchup(scores, [game(), game({ memberId: 'away' })])).toThrow(/one player/)
        expect(() => estimateMatchup(scores, [game({ memberId: 'outside' })])).toThrow(/participating/)
        expect(() => estimateMatchup(scores, [game({ variance: -1 })])).toThrow(/valid numbers/)
        expect(() => estimateMatchup(scores, [game({ expectedPoints: NaN })])).toThrow(/valid numbers/)
        expect(() => estimateMatchup([scores[0], scores[0]], [])).toThrow(/distinct/)
    })
})

describe('historical variation', () => {
    it('requires sufficient observations and uses sample variance', () => {
        expect(sampleScoringVariation([10, 20, 30, 40])).toBeNull()
        expect(sampleScoringVariation([10, 20, 30, 40, 50])).toEqual({ mean: 30, variance: 250, samples: 5 })
        expect(sampleScoringVariation([0, 0, 0, 0, 0])).toEqual({ mean: 0, variance: 0, samples: 5 })
        expect(() => sampleScoringVariation([1, 2, 3, 4, Infinity])).toThrow(/finite/)
    })
})
