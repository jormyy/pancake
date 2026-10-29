import { analyzeTradeEstimate, type TradeEstimateInputs } from '../../../supabase/functions/_shared/tradeEstimate.ts'
import { DYNASTY_TRADE_MODEL_VERSION } from '../../../supabase/functions/_shared/dynastyEngine.ts'

type Inputs = TradeEstimateInputs & { inputVersion: string; observedAt: string; revaluationTradeId: string }

Deno.serve(async request => {
  if (request.method === 'GET') return Response.json({ ready: true, modelVersion: DYNASTY_TRADE_MODEL_VERSION })
  const body = await request.json() as { inputs: Inputs; delay?: number }
  const inputs = body.inputs
  const started = performance.now()
  if (body.delay) await new Promise(resolve => setTimeout(resolve, body.delay))
  const analysis = analyzeTradeEstimate(inputs, Date.parse(inputs.observedAt))
  const analysisMs = performance.now() - started
  return Response.json({ analysisMs, value: {
    tradeId: inputs.revaluationTradeId,
    analysis,
    modelVersion: DYNASTY_TRADE_MODEL_VERSION,
    inputVersion: inputs.inputVersion,
    createdAt: inputs.observedAt,
    expiresAt: new Date(Date.parse(inputs.observedAt) + 600000).toISOString(),
    seasonYear: inputs.seasonYear,
    terms: inputs.terms,
  } })
})

export {}
