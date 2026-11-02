import { supabase } from '../_shared/supabase.ts'
import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { loadForecastContext } from './context.ts'
import { runForecastWork } from './work.ts'
import type { ForecastReceipt } from './work.ts'
import type { Json } from '../_shared/database.ts'

serveInternal('matchup-forecast', async req => {
  const result = await recordSyncRun('matchup-forecast', async () => {
    const outcome = await runForecastWork({
      claim:async()=>{
        const {data,error}=await supabase.rpc('claim_matchup_forecasts',{p_limit:10})
        if(error)throw error
        return data ?? []
      },
      context:loadForecastContext,
      publish:async items=>{
        const {data,error}=await supabase.rpc('complete_matchup_forecasts',{p_results:items.map(item=>({
          matchupId:item.matchup_id,revision:item.revision,claimToken:item.claim_token,
          forecast:item.forecast,validUntil:item.validUntil,
        })) as unknown as Json})
        if(error)throw error
        return data as unknown as ForecastReceipt[]
      },
      fail:async(claim,message)=>{
        const {error}=await supabase.rpc('fail_matchup_forecast',{
          p_matchup_id:claim.matchup_id,p_claim_token:claim.claim_token,p_error:message,
        })
        if(error)throw error
      },
    })
    return {result:outcome,rowsAffected:outcome.completed,failure:outcome.failures.length?outcome.failures.join('\n'):null}
  }, req)
  return Response.json({ ok: result.failures.length === 0, ...result }, { status: result.failures.length ? 500 : 200 })
})
