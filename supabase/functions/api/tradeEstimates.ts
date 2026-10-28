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
  return saveEstimate(userId, memberId, inputs)
}

async function saveEstimate(userId: string, memberId: string, inputs: Json): Promise<TradeEstimateQuote> {
  const analysis = analyzeTradeEstimate(inputs as unknown as TradeEstimateInputs, Date.now())
  const { data: quote, error: saveError } = await supabase.rpc('save_trade_estimate_quote', {
    p_user_id: userId, p_member_id: memberId, p_inputs: inputs,
    p_analysis: analysis as unknown as Json, p_model_version: DYNASTY_TRADE_MODEL_VERSION,
  })
  if (saveError) throwDb(saveError)
  return quote as unknown as TradeEstimateQuote
}

export async function createSubmittedTradeEstimate(tradeId: string): Promise<void> {
  const { data: snapshot, error: snapshotError } = await supabase.from('trade_estimates').select('quote_id').eq('trade_id', tradeId).single()
  if (snapshotError) throwDb(snapshotError)
  if (snapshot.quote_id) return
  const { data: trade, error: tradeError } = await supabase.from('trades').select('proposer_member_id').eq('id', tradeId).single()
  if (tradeError) throwDb(tradeError)
  const { data: member, error: memberError } = await supabase.from('league_members').select('user_id').eq('id', trade.proposer_member_id).single()
  if (memberError) throwDb(memberError)
  const { data, error } = await supabase.rpc('get_trade_revaluation_inputs', {
    p_user_id: member.user_id, p_member_id: trade.proposer_member_id, p_trade_id: tradeId,
  })
  if (error) throwDb(error)
  const inputs = { ...(data as Record<string, Json>) }
  delete inputs.revaluationTradeId
  delete inputs.inputVersion
  delete inputs.observedAt
  inputs.submittedTradeId = tradeId
  await saveEstimate(member.user_id, trade.proposer_member_id, inputs)
}

export async function revalueTrade(userId: string, memberId: string, tradeId: string) {
  const { data, error } = await supabase.rpc('get_trade_revaluation_inputs', {
    p_user_id: userId, p_member_id: memberId, p_trade_id: tradeId,
  })
  if (error) throwDb(error)
  const inputs = data as unknown as TradeEstimateInputs & { inputVersion: string; observedAt: string }
  return {
    tradeId,
    analysis: analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt)),
    modelVersion: DYNASTY_TRADE_MODEL_VERSION,
    inputVersion: inputs.inputVersion,
    createdAt: inputs.observedAt,
    expiresAt: new Date(Date.parse(inputs.observedAt) + 600000).toISOString(),
    seasonYear: inputs.seasonYear,
    terms: inputs.terms,
  }
}

export async function reanalyzeTradeEstimates(runVersion = DYNASTY_TRADE_MODEL_VERSION) {
  const batch = await supabase.rpc('get_trade_estimate_reanalysis_batch', { p_run: runVersion })
  if (batch.error) throwDb(batch.error)
  let updated = 0
  for (const tradeId of batch.data ?? []) {
    const result = await supabase.rpc('get_trade_estimate_reanalysis_inputs', { p_trade_id: tradeId, p_run: runVersion })
    if (result.error) throwDb(result.error)
    if (!result.data) continue
    const inputs = result.data as unknown as TradeEstimateInputs & { observedAt: string }
    const saved = await supabase.rpc('save_trade_estimate_reanalysis', {
      p_trade_id: tradeId, p_run: runVersion, p_inputs: result.data, p_analysis: analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt)) as unknown as Json,
    })
    if (saved.error) throwDb(saved.error)
    updated++
  }
  const queued = await supabase.rpc('queue_trade_estimate_reanalysis', { p_run: runVersion })
  if (queued.error) throwDb(queued.error)
  return { updated, remaining: Number(queued.data) }
}
