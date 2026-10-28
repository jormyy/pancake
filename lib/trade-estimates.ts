import type { DynastyTradeAnalysis, DynastyTradeTeamResult } from '@pancake/core'
import type { Trade } from '@/lib/trades'

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

export function displayedTradeValues(trade: Trade, memberId: string) {
    const saved = trade.estimate?.teams.find(team => team.memberId === memberId)
        ?? trade.estimate?.teams.find(team => team.memberId === trade.proposerMemberId)
    if (!saved && !trade.routedItems.length) return null
    const perspective = saved?.memberId ?? (trade.participants.some(member => member.memberId === memberId) ? memberId : trade.proposerMemberId)
    const value = (direction: 'fromMemberId' | 'toMemberId', fallback: number | null) => {
        const items = trade.routedItems.filter(item => item[direction] === perspective)
        if (!items.length) return fallback ?? 0
        const values = items.map(item => {
            const id = item.kind === 'player' ? item.playerId : item.kind === 'pick' ? item.pickId : `faab:${item.fromMemberId}:${item.toMemberId}`
            return item.tradeValue ?? trade.estimate?.assets?.find(asset => asset.assetId === id)?.values.overall
        })
        return values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))
            ? Number(formatTradeValue(values.reduce((sum, value) => sum + value, 0))) : fallback
    }
    const valuesSent = value('fromMemberId', saved?.valuesSent ?? null)
    const valuesReceived = value('toMemberId', saved?.valuesReceived ?? null)
    return valuesSent == null || valuesReceived == null ? null : { valuesSent, valuesReceived }
}
