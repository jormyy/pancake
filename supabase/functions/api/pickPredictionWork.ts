import { supabase } from '../_shared/supabase.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { recordSyncRun, runEdgeInvocation } from '../_shared/syncRuns.ts'
import { buildPickPredictions, type PickPredictionInput } from '../_shared/pickPredictionWork.ts'

type Result = { data: unknown; error: unknown }
const rpc = async (name: string, args: Record<string, unknown> = {}) => {
  const result: Result = await (supabase.rpc as unknown as (name: string, args: Record<string, unknown>) => Promise<Result>)(name, args)
  if (result.error) throw result.error
  return result.data
}

export async function handlePickPredictionWork(request: Request): Promise<Response> {
  const authError = requireInternalFunctionAuth(request)
  if (authError) return authError
  return runEdgeInvocation('api/trades/pick-values-work', request, async () => {
    const body = await request.json()
    const result = await recordSyncRun('refresh-pick-values', async () => {
      const sourceVersion = typeof body.sourceVersion === 'string' ? body.sourceVersion : ''
      const leagues = await rpc('get_pick_prediction_leagues') as string[]
      let updated = 0
      for (const league of leagues) {
        const input = await rpc('get_pick_prediction_inputs', { p_league_id: league }) as PickPredictionInput | null
        if (!input || input.sourceVersion !== sourceVersion) continue
        updated += Number(await rpc('save_pick_predictions', { p_league_id: league, p_rows: buildPickPredictions(input), p_source_version: sourceVersion }))
      }
      await rpc('complete_pick_prediction_refresh', { p_source_version: sourceVersion })
      return { result: { updated }, rowsAffected: updated }
    }, request)
    return Response.json({ ok: true, result })
  })
}
