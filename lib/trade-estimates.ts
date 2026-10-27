import type { DynastyTradeAnalysis, DynastyTradeTeamResult } from '@pancake/core'
import { apiPost } from '@/lib/shared/api'
import { supabase } from '@/lib/supabase'
import type { MultiTeamTradeItemPayload } from '@/lib/trades'

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

export async function requestTradeRevaluation(memberId: string, tradeId: string): Promise<TradeRevaluation> {
    const result = await apiPost<{ revaluation: TradeRevaluation }>(`/trades/${tradeId}/revalue`, { memberId })
    return result.revaluation
}

export async function requestTradeEstimate(memberId: string, items: MultiTeamTradeItemPayload[]): Promise<TradeEstimateQuote> {
    const result = await apiPost<{ quote: TradeEstimateQuote }>('/trades/estimate', { memberId, items })
    return result.quote
}

export async function getSavedTradeEstimate(quoteId: string): Promise<TradeEstimateQuote> {
    const { data, error } = await supabase.from('trade_estimate_quotes')
        .select('id,analysis,model_version,input_version,created_at,expires_at,inputs->seasonYear')
        .eq('id', quoteId).single()
    if (error) throw error
    return {
        id: data.id,
        analysis: data.analysis as unknown as DynastyTradeAnalysis,
        modelVersion: data.model_version,
        inputVersion: data.input_version,
        createdAt: data.created_at,
        expiresAt: data.expires_at,
        seasonYear: Number(data.seasonYear),
    }
}
