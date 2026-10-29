import { renewCurrentWorkLease } from '../_shared/workContext.ts'
import { supabase } from '../_shared/supabase.ts'
import { revalueTrade } from '../api/tradeEstimates.ts'
import { DYNASTY_TRADE_MODEL_VERSION } from '../_shared/dynastyEngine.ts'
import type { Json } from '../_shared/database.ts'

type TradeWork = {
  revaluationScan?: boolean
  checkInputs?: boolean
  seasonId?: string
  version?: number
  after?: string
  tradeId?: string
  memberId?: string
  userId?: string
  inputFingerprint?: string
  inputs?: Json
}

export async function refreshTradeWork(body: TradeWork): Promise<{ result: Record<string, number | boolean>; rowsAffected: number }> {
  await renewCurrentWorkLease()
  if (body.revaluationScan) {
    if (!body.seasonId || !Number.isSafeInteger(body.version)) throw new Error('Invalid trade scan')
    const { data, error } = await supabase.rpc('view_refresh_work', {
      p_params: { operation: 'queue-trades', ...body, modelVersion: DYNASTY_TRADE_MODEL_VERSION } as unknown as Json,
    })
    if (error) throw error
    return { result: { queued: Number((data as { queued?: number })?.queued ?? 0) }, rowsAffected: Number((data as { queued?: number })?.queued ?? 0) }
  }
  if (!body.tradeId || !body.memberId || !body.userId) throw new Error('Invalid trade revaluation')
  if (body.checkInputs) {
    const { data, error } = await supabase.rpc('get_trade_revaluation_inputs', {
      p_user_id: body.userId, p_member_id: body.memberId, p_trade_id: body.tradeId,
    })
    if (error) throw error
    const inputs = data as { closed?: boolean; inputVersion: string }
    if (inputs.closed) return { result: { queued: false }, rowsAffected: 0 }
    const queued = await supabase.rpc('view_refresh_work', {
      p_params: { operation: 'queue-trade', tradeId: body.tradeId, inputFingerprint: inputs.inputVersion, modelVersion: DYNASTY_TRADE_MODEL_VERSION, inputs: data },
    })
    if (queued.error) throw queued.error
    return { result: { queued: queued.data === true }, rowsAffected: queued.data === true ? 1 : 0 }
  }
  if (!body.inputFingerprint) throw new Error('Missing trade fingerprint')
  const value = await revalueTrade(body.userId, body.memberId, body.tradeId, body.inputFingerprint, body.inputs)
  return { result: { revalued: value !== null }, rowsAffected: value === null ? 0 : 1 }
}
