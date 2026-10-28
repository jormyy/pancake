import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { runEdgeInvocation } from '../_shared/syncRuns.ts'
import { json, readJsonObject, uuidField } from '../_shared/apiRuntime.ts'
import { createSubmittedTradeEstimate, reanalyzeTradeEstimates } from './tradeEstimates.ts'
import { TRADE_FORMULA_VERSION } from '../_shared/dynastyEngineTradeValues.ts'
import { activateLeagueAfterTrade } from '../_shared/tradeActivation.ts'

export async function handleTradeEstimateWork(req: Request): Promise<Response> {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError
  return runEdgeInvocation('api/trades/estimate-work', req, async () => {
    const body = await readJsonObject(req)
    if (body.reanalysisVersion === TRADE_FORMULA_VERSION) return json({ ok: true, ...await reanalyzeTradeEstimates(typeof body.runVersion === 'string' ? body.runVersion : undefined) })
    await createSubmittedTradeEstimate(uuidField(body, 'tradeId'))
    return json({ ok: true })
  })
}

export async function handleTradeActivationWork(req: Request): Promise<Response> {
  return handleTradeWork(req, 'activation', activateLeagueAfterTrade)
}

async function handleTradeWork(req: Request, kind: string, run: (tradeId: string) => Promise<unknown>): Promise<Response> {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError
  return runEdgeInvocation(`api/trades/${kind}-work`, req, async () => {
    const body = await readJsonObject(req)
    await run(uuidField(body, 'tradeId'))
    return json({ ok: true })
  })
}
