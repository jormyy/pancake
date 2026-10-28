import { describe, expect, it } from 'vitest'
import { valueDynastyRankingAsset } from '@/lib/dynasty-ranking-values'
import { valueDynastyAsset } from '@/core/src/dynasty/decisionEngine'

const context = { leagueId: 'league', seasonYear: 2027, scoringSettings: {} }

describe('Hashtag ranking values', () => {
    it('uses the original production, projection, Hashtag rank, and age weights', () => {
        const player = {
            kind: 'player' as const, id: 'player', label: 'Player', age: 22, dynastyRank: 1,
            rankMovement: 0, healthStatus: null, productionFantasyPoints: 26, projectionFantasyPoints: 39,
            tradeValue: 999.9,
        }
        expect(valueDynastyRankingAsset(context, player).values).toEqual({ overall: 690, contend: 580, rebuild: 800 })
        expect(valueDynastyAsset(context, player).values).toEqual({ overall: 999.9, contend: 999.9, rebuild: 999.9 })
    })

    it('restores current-year pick values when the trade source has no matching year', () => {
        const pick = { kind: 'pick' as const, id: 'pick', label: '2026 Round 1', seasonYear: 2027,
            round: 1, slot: null, teams: 12, valueBands: null }
        const result = valueDynastyRankingAsset(context, pick)
        expect(result.values).toEqual({ overall: 687, contend: 605, rebuild: 742 })
        expect(result.ranges.overall).toEqual({ low: 490, high: 884 })
        expect(valueDynastyAsset(context, pick).values.overall).toBe(0)
    })

    it('keeps the original yearly discount and all four rounds without trade bands', () => {
        const rows = [1, 2, 3, 4].map(round => valueDynastyRankingAsset(context, {
            kind: 'pick', id: `pick-${round}`, label: `2027 Round ${round}`, seasonYear: 2028,
            round, slot: null, teams: 12,
        }))
        expect(rows.map(row => row.values.overall)).toEqual([619, 382, 228, 128])
        const later = valueDynastyRankingAsset(context, { kind: 'pick', id: 'later', label: '2029 Round 1',
            seasonYear: 2030, round: 1, slot: null, teams: 12 })
        expect(later.values.overall).toBe(501)
    })
})
