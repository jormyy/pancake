import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {computeForecast} from '../../supabase/functions/matchup-forecast/compute.ts'
assert.equal(process.env.DOCKER_CONTEXT,'desktop-linux')
const url='postgresql://postgres:postgres@127.0.0.1:64822/postgres'
const sql=input=>execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:16*1024*1024}).trim()
const json=input=>JSON.parse(sql(input))
const literal=value=>`'${String(value).replaceAll("'","''")}'`
const report={before:json("SELECT jsonb_build_object('dirty',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty),'blocked',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty AND private.matchup_forecast_refresh_pending(matchup_id)))"),claims:[]}
sql("DO $$ DECLARE r jsonb; BEGIN FOR n IN 1..1000 LOOP r:=public.run_scheduler_chunk('forecasts'); EXIT WHEN NOT(r->>'remaining')::boolean; END LOOP; END $$;")
for(let batch=0;batch<5;batch++){
 const claims=json('SELECT coalesce(jsonb_agg(to_jsonb(c)),\'[]\') FROM public.claim_matchup_forecasts(25) c;')
 if(!claims.length)break
 for(const claim of claims){
  try{
   const dates=json(`SELECT public.prepare_matchup_forecast_inputs(${literal(claim.matchup_id)});`)
   for(const date of dates)sql(`SELECT public.prepare_matchup_forecast_inputs(${literal(claim.matchup_id)},${literal(date)});`)
   const context=json(`SELECT public.get_prepared_matchup_forecast_context(${literal(claim.matchup_id)});`)
   const forecast=computeForecast(context)
   const now=Date.parse(context.observedAt)
   const next=context.games.map(g=>Date.parse(g.game_time??'')).filter(t=>t>now).sort((a,b)=>a-b)[0]
   const expires=new Date(Math.min(now+6*3600e3,next??Infinity)).toISOString()
   const saved=sql(`SELECT public.complete_matchup_forecast(${literal(claim.matchup_id)},${claim.revision},${literal(claim.claim_token)},${literal(JSON.stringify(forecast))}::jsonb,${literal(expires)});`)
   report.claims.push({saved,dates:dates.length})
  }catch(error){report.claims.push({error:error.message.slice(-500)})}
 }
}
report.after=json("SELECT jsonb_build_object('dirty',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty),'blocked',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty AND private.matchup_forecast_refresh_pending(matchup_id)),'dueRequests',(SELECT count(*) FROM private.forecast_refresh_requests WHERE available_at<=now()),'dueExpiries',(SELECT count(*) FROM private.matchup_forecast_expiries WHERE available_at<=now()))")
writeFileSync('/tmp/fable-l7/evidence/forecast-diagnose.json',JSON.stringify(report,null,2))
process.stdout.write(JSON.stringify(report)+'\n')
