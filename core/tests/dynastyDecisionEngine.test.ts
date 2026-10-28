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

const tradedPlayer = (...args: Parameters<typeof player>): DynastyPlayerAsset => ({ ...player(...args), tradeValue: Math.max(0, 1000 - args[1] * 2) })

describe('dynasty decision engine', () => {
    it('rejects repeated assets and routes that do not transfer ownership', () => {
        const route = { fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('one', 40, 20) }
        expect(() => analyzeDynastyTrade(context, 'overall', [route, route])).toThrow(/once/)
        expect(() => analyzeDynastyTrade(context, 'overall', [{ ...route, toMemberId: 'a' }])).toThrow(/different/)
    })

    it('exposes exact package accounting and reverses uneven trade adjustments', () => {
        const routes = [
            { fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('one', 40, 20) },
            { fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('two', 80, 15) },
            { fromMemberId: 'b', toMemberId: 'a', asset: tradedPlayer('elite', 8, 28) },
        ]
        const input = { ...context, replacementValue: 125 }
        const forward = analyzeDynastyTrade(input, 'overall', routes)
        const reverse = analyzeDynastyTrade(input, 'overall', routes.map(route => ({
            ...route, fromMemberId: route.toMemberId, toMemberId: route.fromMemberId,
        })))
        expect(forward.teams[0].valuesSent).toBe(forward.assets[0].values.overall + forward.assets[1].values.overall)
        for (const [index, team] of forward.teams.entries()) {
            expect(team.impact).toBe(team.valuesReceived - team.valuesSent + team.packageEffect + team.rosterSlotEffect + team.replacementEffect)
            expect(reverse.teams[index].impact).toBe(-team.impact || 0)
            expect(reverse.teams[index].replacementEffect).toBe(-team.replacementEffect || 0)
        }
    })

    it('values all transferred FAAB even when a manager holds more than the season grant', () => {
        const asset = { kind: 'faab' as const, id: 'funds', label: 'FAAB', budget: 100, freeAgentQuality: 0.5, amount: 200 }
        expect(valueDynastyAsset(context, asset).values.overall).toBe(195)
        expect(valueDynastyAsset(context, { ...asset, amount: 100 }).values.overall).toBe(98)
    })

    it('uses imported values for every strategy and ignores legacy inputs', () => {
        const asset = tradedPlayer('player-1', 80, 30)
        const result = valueDynastyAsset(context, asset)
        const changed = valueDynastyAsset({ ...context, scoringSettings: { points: 100 } }, {
            ...asset, age: 40, healthStatus: 'OUT', marketRanks: { overall: 1, contend: 500, rebuild: 500 },
        })
        expect(result.values).toEqual({ overall: 840, contend: 840, rebuild: 840 })
        expect(changed.values).toEqual(result.values)
        expect(result.ranges).toEqual({})
        expect(result.components.production).toBe(0)
        expect(result.components.age).toBe(0)
    })

    it('gives missing imported values zero instead of synthesizing a rank or age value', () => {
        const asset = player('player-1', 1, 55, 22)
        const result = valueDynastyAsset(context, asset)
        expect(result.values).toEqual({ overall: 0, contend: 0, rebuild: 0 })
        expect(result.missingInputs).toEqual(['imported player value'])
        expect(result.ranges).toEqual({})
    })

    it('keeps Overall stable when the selected strategy changes', () => {
        const result = valueDynastyAsset(context, tradedPlayer('young-star', 8, 25, 21))
        const analyses = ['overall', 'contend', 'rebuild'] as const
        const routes: DynastyTradeRoute[] = [{ fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('young-star', 8, 25, 21) }]

        for (const strategy of analyses) {
            expect(analyzeDynastyTrade(context, strategy, routes).assets[0].values.overall).toBe(result.values.overall)
        }
        expect(result.values.rebuild).toBe(result.values.contend)
    })

    it('returns a wider and less certain range for an unknown future pick', () => {
        const known = valueDynastyAsset(context, {
            kind: 'pick', id: 'known', label: '2027 1.03', seasonYear: 2027, round: 1, slot: 3, teams: 12, valueBands: { early: 700, mid: 500, late: 300 },
        })
        const unknown = valueDynastyAsset(context, {
            kind: 'pick', id: 'unknown', label: '2029 first', seasonYear: 2029, round: 1, slot: null, teams: 12, valueBands: { early: 700, mid: 500, late: 300 },
        })

        expect(known.ranges.overall).toBeUndefined()
        expect(unknown.ranges.overall?.high).toBeGreaterThan(unknown.ranges.overall?.low ?? 0)
        expect(unknown.confidence).toBeLessThan(known.confidence)
        expect(unknown.missingInputs).toContain('pick slot')
    })

    it('reverses two-team impacts when every route reverses', () => {
        const routes: DynastyTradeRoute[] = [
            { fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('alpha', 15, 25) },
            { fromMemberId: 'b', toMemberId: 'a', asset: tradedPlayer('beta', 60, 18) },
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
            expect(reverseTeam?.impact).toBe(-(forwardTeam?.impact ?? 0) || 0)
            expect(reverseTeam?.shortTermPoints).toBe(-(forwardTeam?.shortTermPoints ?? 0) || 0)
        }
    })

    it('uses consolidation without an extra roster-slot adjustment', () => {
        const analysis = analyzeDynastyTrade(context, 'overall', [
            { fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('one', 40, 20) },
            { fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('two', 80, 15) },
            { fromMemberId: 'b', toMemberId: 'a', asset: tradedPlayer('elite', 8, 28) },
        ])

        expect(analysis.teams.find((team) => team.memberId === 'a')?.rosterSlotEffect).toBe(0)
        expect(analysis.teams.find((team) => team.memberId === 'b')?.rosterSlotEffect).toBe(0)
    })

    it('prevents weak asset count from overwhelming one elite asset', () => {
        const assets = valueDynastyAssets(context, [
            tradedPlayer('elite', 1, 42, 22),
            tradedPlayer('weak-1', 450, 2, 34),
            tradedPlayer('weak-2', 460, 2, 34),
            tradedPlayer('weak-3', 470, 2, 34),
            tradedPlayer('weak-4', 480, 2, 34),
        ])
        const elite = assets[0].values.overall
        const analysis = analyzeDynastyTrade(context, 'overall', [
            ...assets.slice(1).map((_, index) => ({
                fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer(`weak-${index + 1}`, 450 + index * 10, 2, 34),
            })),
            { fromMemberId: 'b', toMemberId: 'a', asset: tradedPlayer('elite', 1, 42, 22) },
        ])
        const weakPackage = analysis.teams.find((team) => team.memberId === 'a')?.valuesSent ?? 0

        expect(weakPackage).toBeLessThan(elite)
        expect(analysis.teams.find((team) => team.memberId === 'b')?.packageEffect).toBeLessThan(0)
    })

    it('does not let a negative asset increase the sending package', () => {
        const baseRoutes: DynastyTradeRoute[] = [
            { fromMemberId: 'a', toMemberId: 'b', asset: tradedPlayer('starter', 80, 18) },
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
            const result = valueDynastyAsset(context, tradedPlayer(`player-${rank}`, rank, rank % 55, 18 + rank % 24))
            for (const value of Object.values(result.values)) {
                expect(Number.isFinite(value)).toBe(true)
                expect(value).toBeGreaterThanOrEqual(0)
                expect(value).toBeLessThanOrEqual(1000)
            }
        }
    })
})
