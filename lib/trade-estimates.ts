import type { DynastyTradeAnalysis, DynastyTradeTeamResult } from '@pancake/core'

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
}

export type TradeRevaluation = Omit<TradeEstimateQuote, 'id'> & { tradeId: string }
