import type { DynastyTradeAnalysis, DynastyTradeTeamResult } from '@/core/src/dynasty/decisionEngine'
import type { Trade } from '@/lib/trades'
import { compareTradeTotals, curveTradeValue, scoreTradeSides, TRADE_FORMULA_VERSION } from '@/core/src/dynasty/tradeScoring'

export type TradeEstimateQuote = {
    id: string
    analysis: DynastyTradeAnalysis
    modelVersion: string
    inputVersion: string
    createdAt: string
    expiresAt: string
    seasonYear: number
}

export type TradeEstimateSummary = {
    quoteId: string
    modelVersion: string
    inputVersion: string
    createdAt: string
    teams: DynastyTradeTeamResult[]
    assets?: DynastyTradeAnalysis['assets']
}

export type TradeRevaluation = Omit<TradeEstimateQuote, 'id'> & { tradeId: string }

export function formatTradeValue(value: number): string {
    return String(Number(value.toFixed(2)))
}

export function tradeComparison(teams: DynastyTradeTeamResult[]) {
    const totals = teams.map(team => ({ memberId: team.memberId,
        total: team.adjustedValue ?? team.valuesReceived + team.rosterSlotEffect,
        net: team.netValue ?? team.valuesReceived - team.valuesSent + team.rosterSlotEffect }))
    const comparisons = teams.map((team, index) => compareTradeTotals([team.valuesSent, totals[index].total]))
    const comparison = teams.length === 2 ? compareTradeTotals(totals.map(team => team.total))
        : { gapPercent: Math.max(0, ...comparisons.map(result => result.gapPercent)), fair: comparisons.every(result => result.fair) }
    const winner = [...totals].sort((a, b) => b.net - a.net)[0]?.memberId ?? null
    return { ...comparison, totals, winnerMemberId: comparison.fair ? null : winner }
}

export function displayedTradeValues(trade: Trade, memberId: string) {
    const perspective = memberId === trade.proposerMemberId || memberId === trade.recipientMemberId || trade.participants.some(member => member.memberId === memberId) ? memberId : trade.proposerMemberId
    const savedTeams = trade.estimate?.modelVersion === TRADE_FORMULA_VERSION ? trade.estimate.teams : null
    const saved = savedTeams?.find(team => team.memberId === perspective)
    if (saved) return { ...saved, comparison: tradeComparison(savedTeams!) }
    if (!trade.routedItems.length) return null
    const values = trade.routedItems.map(item => {
        const id = item.kind === 'player' ? item.playerId : item.kind === 'pick' ? item.pickId : `faab:${item.fromMemberId}:${item.toMemberId}`
        return item.tradeValue ?? trade.estimate?.assets?.find(asset => asset.assetId === id)?.values.overall
    })
    if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return null
    const teams = [...new Set(trade.routedItems.flatMap(item => [item.fromMemberId, item.toMemberId]))].map(id => {
        const side = (direction: 'fromMemberId' | 'toMemberId', faab: boolean) => values.filter((_, index) =>
            trade.routedItems[index][direction] === id && (trade.routedItems[index].kind === 'faab') === faab)
        const score = scoreTradeSides(side('fromMemberId', false), side('toMemberId', false), 0,
            side('fromMemberId', true).reduce((sum, value) => sum + value, 0), side('toMemberId', true).reduce((sum, value) => sum + value, 0))
        return { memberId: id, ...score, adjustedValue: score.adjustedReceived, rosterSlotEffect: 0,
            replacementEffect: 0, shortTermPoints: 0, longTermValue: score.netValue }
    })
    const team = teams.find(team => team.memberId === perspective)
    return team ? { ...team, comparison: tradeComparison(teams) } : null
}

export function curvedAssetValue(asset: DynastyTradeAnalysis['assets'][number], strategy: DynastyTradeAnalysis['strategy']) {
    return asset.kind === 'faab' ? asset.values[strategy] : curveTradeValue(asset.values[strategy])
}
