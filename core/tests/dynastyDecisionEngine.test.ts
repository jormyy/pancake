import { describe, expect, it } from 'vitest'
import {
    analyzeDynastyTrade,
    valueDynastyAsset,
    valueDynastyAssets,
    type DynastyEngineContext,
    type DynastyPlayerAsset,
    type DynastyTradeRoute,
} from '../src/dynasty/decisionEngine'
import type { StatLine } from '../src/scoring/types'

const settings = {
    points: 1,
    rebounds: 1.2,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 0.5,
}

const context: DynastyEngineContext = {
    leagueId: 'league-a',
    seasonYear: 2026,
    scoringSettings: settings,
    replacementValue: 180,
}

const statLine = (points: number, rebounds = 5, assists = 5): StatLine => ({
    points,
    rebounds,
    assists,
    steals: 1,
    blocks: 1,
    turnovers: 2,
    threePointersMade: 2,
    fieldGoalsMade: 0,
    fieldGoalsAttempted: 0,
    freeThrowsMade: 0,
    freeThrowsAttempted: 0,
    doubleDouble: false,
    tripleDouble: false,
    didNotPlay: false,
})

const player = (id: string, rank: number, points: number, age = 25): DynastyPlayerAsset => ({
    kind: 'player',
    id,
    label: id,
    age,
    dynastyRank: rank,
    rankMovement: 0,
    healthStatus: null,
    productionStats: statLine(points),
    projectionStats: statLine(points + 1),
    sources: [{ name: 'test', fetchedAt: '2026-08-16T00:00:00Z' }],
})

describe('dynasty decision engine', () => {
    it('returns the same result for the same input', () => {
        const asset = player('player-1', 12, 24)
        expect(valueDynastyAsset(context, asset)).toEqual(valueDynastyAsset(context, asset))
    })

    it('uses active league scoring settings', () => {
        const asset = player('player-1', 80, 30)
        const pointsLeague = valueDynastyAsset(context, asset)
        const assistsLeague = valueDynastyAsset({
            ...context,
            scoringSettings: { ...settings, points: 0, assists: 4 },
        }, asset)

        expect(pointsLeague.components.shortTermPoints).not.toBe(assistsLeague.components.shortTermPoints)
        expect(pointsLeague.values.overall).not.toBe(assistsLeague.values.overall)
    })

    it('uses the published market rank for each strategy', () => {
        const baseline = valueDynastyAsset(context, player('player-1', 250, 30))
        const result = valueDynastyAsset(context, {
            ...player('player-1', 250, 30),
            marketRanks: { overall: 1, contend: 400, rebuild: 500 },
        })

        expect(result.values.overall).toBeGreaterThan(baseline.values.overall)
        expect(result.values.contend).toBeLessThan(baseline.values.contend)
        expect(result.values.rebuild).toBeLessThan(baseline.values.rebuild)
    })

    it('keeps Overall stable when the selected strategy changes', () => {
        const result = valueDynastyAsset(context, player('young-star', 8, 25, 21))
        const analyses = ['overall', 'contend', 'rebuild'] as const
        const routes: DynastyTradeRoute[] = [{ fromMemberId: 'a', toMemberId: 'b', asset: player('young-star', 8, 25, 21) }]

        for (const strategy of analyses) {
            expect(analyzeDynastyTrade(context, strategy, routes).assets[0].values.overall).toBe(result.values.overall)
        }
        expect(result.values.rebuild).toBeGreaterThan(result.values.contend)
    })

    it('returns a wider and less certain range for an unknown future pick', () => {
        const known = valueDynastyAsset(context, {
            kind: 'pick', id: 'known', label: '2027 1.03', seasonYear: 2027, round: 1, slot: 3, teams: 12,
        })
        const unknown = valueDynastyAsset(context, {
            kind: 'pick', id: 'unknown', label: '2029 first', seasonYear: 2029, round: 1, slot: null, teams: 12,
        })

        expect(known.ranges.overall).toBeUndefined()
        expect(unknown.ranges.overall?.high).toBeGreaterThan(unknown.ranges.overall?.low ?? 0)
        expect(unknown.confidence).toBeLessThan(known.confidence)
        expect(unknown.missingInputs).toContain('pick slot')
    })

    it('reverses two-team impacts when every route reverses', () => {
        const routes: DynastyTradeRoute[] = [
            { fromMemberId: 'a', toMemberId: 'b', asset: player('alpha', 15, 25) },
            { fromMemberId: 'b', toMemberId: 'a', asset: player('beta', 60, 18) },
        ]
        const forward = analyzeDynastyTrade(context, 'overall', routes)
        const reverse = analyzeDynastyTrade(context, 'overall', routes.map((route) => ({
            ...route,
            fromMemberId: route.toMemberId,
            toMemberId: route.fromMemberId,
        })))

        for (const memberId of ['a', 'b']) {
            const forwardTeam = forward.teams.find((team) => team.memberId === memberId)
            const reverseTeam = reverse.teams.find((team) => team.memberId === memberId)
            expect(reverseTeam?.impact).toBe(-(forwardTeam?.impact ?? 0))
            expect(reverseTeam?.shortTermPoints).toBe(-(forwardTeam?.shortTermPoints ?? 0))
        }
    })

    it('adds a roster-slot effect to a two-for-one', () => {
        const analysis = analyzeDynastyTrade(context, 'overall', [
            { fromMemberId: 'a', toMemberId: 'b', asset: player('one', 40, 20) },
            { fromMemberId: 'a', toMemberId: 'b', asset: player('two', 80, 15) },
            { fromMemberId: 'b', toMemberId: 'a', asset: player('elite', 8, 28) },
        ])

        expect(analysis.teams.find((team) => team.memberId === 'a')?.rosterSlotEffect).toBeGreaterThan(0)
        expect(analysis.teams.find((team) => team.memberId === 'b')?.rosterSlotEffect).toBeLessThan(0)
    })

    it('prevents weak asset count from overwhelming one elite asset', () => {
        const assets = valueDynastyAssets(context, [
            player('elite', 1, 42, 22),
            player('weak-1', 450, 2, 34),
            player('weak-2', 460, 2, 34),
            player('weak-3', 470, 2, 34),
            player('weak-4', 480, 2, 34),
        ])
        const elite = assets[0].values.overall
        const analysis = analyzeDynastyTrade(context, 'overall', [
            ...assets.slice(1).map((_, index) => ({
                fromMemberId: 'a', toMemberId: 'b', asset: player(`weak-${index + 1}`, 450 + index * 10, 2, 34),
            })),
            { fromMemberId: 'b', toMemberId: 'a', asset: player('elite', 1, 42, 22) },
        ])
        const weakPackage = analysis.teams.find((team) => team.memberId === 'a')?.valuesSent ?? 0

        expect(weakPackage).toBeLessThan(elite)
        expect(analysis.teams.find((team) => team.memberId === 'b')?.packageEffect).toBeLessThan(0)
    })

    it('does not let a negative asset increase the sending package', () => {
        const baseRoutes: DynastyTradeRoute[] = [
            { fromMemberId: 'a', toMemberId: 'b', asset: player('starter', 80, 18) },
        ]
        const withCost: DynastyTradeRoute[] = [
            ...baseRoutes,
            {
                fromMemberId: 'a',
                toMemberId: 'b',
                asset: { kind: 'rosterSlot', id: 'cost', label: 'Occupied slot', count: -1, replacementValue: 180 },
            },
        ]
        const base = analyzeDynastyTrade(context, 'overall', baseRoutes)
        const cost = analyzeDynastyTrade(context, 'overall', withCost)

        expect(cost.teams.find((team) => team.memberId === 'a')?.valuesSent).toBe(
            base.teams.find((team) => team.memberId === 'a')?.valuesSent,
        )
    })

    it('keeps every finite value inside the display scale', () => {
        for (let rank = 1; rank <= 500; rank += 7) {
            const result = valueDynastyAsset(context, player(`player-${rank}`, rank, rank % 55, 18 + rank % 24))
            for (const value of Object.values(result.values)) {
                expect(Number.isFinite(value)).toBe(true)
                expect(value).toBeGreaterThanOrEqual(0)
                expect(value).toBeLessThanOrEqual(1000)
            }
        }
    })
})
