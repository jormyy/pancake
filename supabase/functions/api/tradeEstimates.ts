import { supabase } from '../_shared/supabase.ts'
import { throwDb } from '../_shared/apiRuntime.ts'
import { analyzeTradeEstimate, type EstimateTerm, type TradeEstimateInputs } from '../_shared/tradeEstimate.ts'
import { DYNASTY_TRADE_MODEL_VERSION, type DynastyTradeAnalysis } from '../_shared/dynastyEngine.ts'
import type { Json } from '../_shared/database.ts'

export type TradeEstimateQuote = {
  id: string
  analysis: DynastyTradeAnalysis
  modelVersion: string
  inputVersion: string
  createdAt: string
  expiresAt: string
  seasonYear: number
  terms: EstimateTerm[]
}

export async function createTradeEstimate(userId: string, memberId: string, items: Json): Promise<TradeEstimateQuote> {
  const { data: inputs, error } = await supabase.rpc('get_trade_estimate_inputs', {
    p_user_id: userId, p_member_id: memberId, p_items: items,
  })
  if (error) throwDb(error)
  const analysis = analyzeTradeEstimate(inputs as unknown as TradeEstimateInputs, Date.now())
  const { data: quote, error: saveError } = await supabase.rpc('save_trade_estimate_quote', {
    p_user_id: userId, p_member_id: memberId, p_inputs: inputs,
    p_analysis: analysis as unknown as Json, p_model_version: DYNASTY_TRADE_MODEL_VERSION,
  })
  if (saveError) throwDb(saveError)
  return quote as unknown as TradeEstimateQuote
}
