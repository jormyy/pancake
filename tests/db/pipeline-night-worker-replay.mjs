import assert from 'node:assert/strict'
import {execFileSync,spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {homedir} from 'node:os'
import {setTimeout as pause} from 'node:timers/promises'
import {computeForecast} from '../../supabase/functions/matchup-forecast/compute.ts'

const lane=path.join(homedir(),'pancake-t_4ba51e0d/lanes/fable-ui27')
assert.equal(process.cwd(),path.join(lane,'repo'))
assert.match(readFileSync('supabase/config.toml','utf8'),/^project_id = "pt4bafablesr"$/m)
const url='postgresql://postgres:postgres@127.0.0.1:64222/postgres'
execFileSync('psql',[url.replace('postgres:postgres@','supabase_admin:postgres@'),'-XqAtv','ON_ERROR_STOP=1'],{
  input:'GRANT USAGE,CREATE ON SCHEMA pipeline_night_lab TO postgres;',encoding:'utf8',
})
const literal=value=>`'${String(value).replaceAll("'","''")}'`
const sql=input=>execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:32*1024*1024}).trim()
const json=input=>JSON.parse(sql(input))
const cleanContext=id=>json(`SELECT private.compute_matchup_forecast_context(${id})||jsonb_build_object('seasonAverages',coalesce((SELECT jsonb_agg(jsonb_build_object('player_id',a.player_id,'avg_fantasy_points',a.avg_fantasy_points) ORDER BY a.player_id) FROM public.v_player_avg_fantasy_points a JOIN public.matchups m ON m.id=${id} JOIN public.league_seasons s ON s.id=m.league_season_id WHERE a.league_id=m.league_id AND a.season_year=s.season_year AND a.player_id IN(SELECT player_id FROM public.roster_players r WHERE r.league_season_id=m.league_season_id AND r.member_id IN(m.home_member_id,m.away_member_id))),'[]'::jsonb));`)
const targetKinds="'forecast-inputs','notification-scan','trade-revaluation-scan','trade-revaluation','trade-revaluation-check','matchup-forecasts'"
const settings="SET app.supabase_url='http://127.0.0.1:64221'; SET app.edge_internal_token='private-pipeline-night';"
const quiet=()=>sql(`${settings}
  UPDATE private.work_items SET lease_until=now()+interval '5 minutes' WHERE key LIKE 'worker-holder-%';
  SELECT private.enqueue_scheduled_work(now());
  UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE status IN('pending','failed') AND kind NOT IN(${targetKinds});
  DELETE FROM public.notification_outbox;`)
const completeForecasts=()=>{
  const claims=json("SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM public.claim_matchup_forecasts(25) c;")
  for(const claim of claims){
    const id=literal(claim.matchup_id),dates=json(`SELECT public.prepare_matchup_forecast_inputs(${id});`)
    for(const date of dates)sql(`SELECT public.prepare_matchup_forecast_inputs(${id},${literal(date)});`)
    const context=json(`SELECT public.get_prepared_matchup_forecast_context(${id});`),forecast=computeForecast(context)
    const observed=Date.parse(context.observedAt),tip=context.games.map(g=>Date.parse(g.game_time??'')).filter(t=>t>observed).sort((a,b)=>a-b)[0]
    assert.equal(sql(`SELECT public.complete_matchup_forecast(${id},${claim.revision},${literal(claim.claim_token)},${literal(JSON.stringify(forecast))},${literal(new Date(Math.min(observed+21600000,tip??Infinity)).toISOString())});`),'t')
  }
  return claims.length
}
sql(`${settings}
  DELETE FROM private.work_items; DELETE FROM public.edge_invocations; DELETE FROM public.notification_outbox;
  DELETE FROM private.trade_revaluation_leagues;
  UPDATE private.work_kinds SET last_claimed_at=NULL;
  UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_checked_at=NULL,scheduler_healthy_since=NULL WHERE id;
  UPDATE public.trades SET expires_at=now()+interval '1 day' WHERE status='pending';
  UPDATE public.trades SET veto_window_expires_at=now()+interval '1 day' WHERE status='accepted';
  UPDATE public.nba_games SET status='Final',stats_synced_at=now() WHERE game_date<(now() AT TIME ZONE 'America/New_York')::date;
  UPDATE public.sync_jobs SET status='completed',completed_at=now() WHERE status IN('pending','running','failed');
  UPDATE private.screen_refresh_queue SET dirty=false;
  UPDATE private.notification_scan_state SET available_at=now(),scan_at=NULL; DELETE FROM private.notification_scan_dirty;
  DELETE FROM private.forecast_refresh_requests; DELETE FROM private.matchup_forecast_expiries;
  UPDATE private.matchup_forecast_queue SET dirty=true,available_at=now(),claimed_at=NULL,claim_token=NULL,claimed_revision=NULL,
    input_fingerprint=private.matchup_forecast_input_fingerprint(matchup_id);`)
for(let batch=0;batch<8;batch++)if(!completeForecasts())break
quiet()
sql(`DELETE FROM private.work_items; DELETE FROM public.edge_invocations; DELETE FROM public.notification_outbox;
  DELETE FROM private.forecast_refresh_requests; DELETE FROM private.matchup_forecast_expiries;
  INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
    SELECT 'matchup:'||id,id,'2026-10-30T06:19:16.613194Z' FROM public.matchups ORDER BY id LIMIT 82;
  DROP TABLE IF EXISTS pipeline_night_lab.trade_targets;
  CREATE TABLE pipeline_night_lab.trade_targets AS SELECT t.id AS trade_id,t.league_id,t.league_season_id,
    m.id AS member_id,m.user_id,row_number() OVER(ORDER BY t.id) AS ordinal,count(*) OVER() AS total
    FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id WHERE t.status IN('pending','accepted');`)
assert.ok(json('SELECT count(*) FROM pipeline_night_lab.trade_targets;')>0)
sql(`INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
    SELECT 'stats-sync','worker-holder-'||n,'running',1,gen_random_uuid(),now()+interval '5 minutes',jsonb_build_object('holder',n)
    FROM generate_series(1,2) n;
  INSERT INTO private.work_items(kind,key,due_at,status,attempts,last_error,payload,league_id)
    SELECT 'trade-revaluation-check',CASE WHEN n<=330 THEN 'worker-old-check-' ELSE 'worker-failed-check-' END||n,
      CASE WHEN n<=330 THEN '2026-10-30T05:33:02Z'::timestamptz+n*interval '1 millisecond' ELSE '2026-10-30T06:18:00Z'::timestamptz END,
      CASE WHEN n<=330 THEN 'pending' ELSE 'failed' END,CASE WHEN n<=330 THEN 0 ELSE 1 END,
      CASE WHEN n>330 THEN 'Worker lease expired' END,
      jsonb_build_object('checkInputs',true,'tradeId',t.trade_id,'memberId',t.member_id,'userId',t.user_id,'version',n,'replay',n),t.league_id
      FROM generate_series(1,337) n JOIN pipeline_night_lab.trade_targets t ON t.ordinal=1+(n-1)%t.total;
  INSERT INTO private.work_items(kind,key,due_at,status,attempts,last_error,payload,league_id)
    SELECT 'trade-revaluation-scan','worker-scan-'||n,
      CASE WHEN n<=41 THEN '2026-10-30T05:37:00Z'::timestamptz+n*interval '1 millisecond' ELSE '2026-10-30T06:18:00Z'::timestamptz END,
      CASE WHEN n<=41 THEN 'pending' ELSE 'failed' END,CASE WHEN n<=41 THEN 0 ELSE 1 END,
      CASE WHEN n=42 THEN 'Worker lease expired' END,
      jsonb_build_object('revaluationScan',true,'seasonId',t.league_season_id,'version',n,'replay',n),t.league_id
      FROM generate_series(1,42) n JOIN pipeline_night_lab.trade_targets t ON t.ordinal=1;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    SELECT 'trade-revaluation','worker-revaluation-'||n,'2026-10-30T05:37:01Z'::timestamptz+n*interval '1 millisecond',
      jsonb_build_object('latestInputs',true,'tradeId',t.trade_id,'memberId',t.member_id,'userId',t.user_id,'replay',n),t.league_id
      FROM generate_series(1,8) n JOIN pipeline_night_lab.trade_targets t ON t.ordinal=1+(n-1)%t.total;
  INSERT INTO private.work_items(kind,key,due_at,payload) VALUES
    ('notification-scan','worker-notification-7514','2026-10-30T06:21:00Z','{"schedulerChunk":"notifications","at":"2026-10-30T12:38:00Z"}'),
    ('forecast-inputs','worker-inputs-7519','2026-10-30T06:42:00Z','{"schedulerChunk":"forecasts"}'),
    ('matchup-forecasts','worker-legacy-empty',now(),'{}');
  DROP TABLE IF EXISTS pipeline_night_lab.seeded_work;
  CREATE TABLE pipeline_night_lab.seeded_work AS SELECT id,kind,key,attempts FROM private.work_items
    WHERE key LIKE 'worker-%' AND key NOT LIKE 'worker-holder-%' AND kind<>'matchup-forecasts';`)
assert.equal(json('SELECT count(*) FROM pipeline_night_lab.seeded_work;'),389)
if(process.argv[2]==='seed')process.exit(0)
const calls={},events=[]
let worker,workerLog=''
const allowed=new Set(['run_scheduler_chunk','start_edge_invocation','renew_work_lease','finish_edge_invocation','view_refresh_work','get_trade_revaluation_inputs'])
const api=createServer(async(req,res)=>{
  try{
    const name=req.url.split('/').at(-1)
    assert.ok(allowed.has(name));assert.equal(req.method,'POST')
    let body='';for await(const part of req)body+=part
    const args=JSON.parse(body),headers=JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([key])=>key==='x-pancake-work-key')))
    const value=sql(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.headers=${literal(headers)};
      SELECT coalesce(to_jsonb(public.${name}(${Object.entries(args).map(([key,value])=>`${key}=>${typeof value==='boolean'||typeof value==='number'?value:value===null?'NULL':literal(typeof value==='object'?JSON.stringify(value):value)}`).join(',')})),'null'); COMMIT;`)
    calls[name]=(calls[name]??0)+1
    res.writeHead(200,{'content-type':'application/json'});res.end(value)
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({code:'P0001',message:String(error.stderr??error.message).slice(-3000)}))}
})
await new Promise(resolve=>api.listen(64239,'127.0.0.1',resolve))
try{
  worker=spawn('deno',['run','--cached-only','--no-check','--no-config','--allow-net=127.0.0.1:64238,127.0.0.1:64239','--allow-env','tests/db/pipeline-night-worker-edge.mjs'],{
    env:{...process.env,SUPABASE_URL:'http://127.0.0.1:64239',PANCAKE_SUPABASE_SECRET_KEY:'sb_secret_pipeline_fixture',PANCAKE_EDGE_INTERNAL_TOKEN:'private-pipeline-night'},stdio:['ignore','pipe','pipe']})
  worker.stdout.on('data',part=>{workerLog+=part});worker.stderr.on('data',part=>{workerLog+=part})
  let ready=false
  for(let attempt=0;attempt<100;attempt++){
    if(worker.exitCode!==null)throw new Error(workerLog)
    try{await fetch('http://127.0.0.1:64238');ready=true;break}catch{await pause(100)}
  }
  assert.ok(ready,workerLog)
  for(let tick=1;tick<=1000;tick++){
    quiet()
    sql(`${settings} SELECT public.dispatch_work();`)
    const jobs=json("SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') FROM private.work_items w WHERE status='running' AND key NOT LIKE 'worker-holder-%';")
    for(const job of jobs){
      const start=Date.now()
      if(['forecast-inputs','notification-scan','trade-revaluation-scan','trade-revaluation','trade-revaluation-check'].includes(job.kind)){
        const response=await fetch('http://127.0.0.1:64238',{method:'POST',headers:{'content-type':'application/json','x-internal-function-token':'private-pipeline-night','x-pancake-invocation-id':job.invocation_key,'x-pancake-work-id':String(job.id)},body:JSON.stringify(job.payload)})
        const value=await response.json();assert.equal(response.status,200,JSON.stringify(value))
        assert.equal(sql(`SELECT status FROM private.work_items WHERE id=${job.id};`),'succeeded',workerLog)
      }else{
        if(job.kind==='matchup-forecasts')completeForecasts()
        sql(`SELECT private.work_finish(${job.id},${literal(job.lease_token)});`)
      }
      events.push({tick,kind:job.kind,key:job.key,attempts:job.attempts,ms:Date.now()-start})
    }
    const state=json(`SELECT jsonb_build_object('remaining',count(*) FILTER(WHERE w.status<>'succeeded'),
      'oldChecks',count(*) FILTER(WHERE w.status='succeeded' AND w.key LIKE 'worker-old-check-%'),
      'byKind',coalesce((SELECT jsonb_object_agg(kind,n) FROM(SELECT s.kind,count(*) n FROM pipeline_night_lab.seeded_work s JOIN private.work_items w ON w.id=s.id WHERE w.status<>'succeeded' GROUP BY s.kind) r),'{}'),
      'dueRequests',(SELECT count(*) FROM private.forecast_refresh_requests WHERE available_at<=now()))
      FROM pipeline_night_lab.seeded_work s JOIN private.work_items w ON w.id=s.id;`)
    if(tick<=6||tick%20===0||state.remaining===0)process.stdout.write(JSON.stringify({tick,...state})+'\n')
    if(!state.remaining){
      assert.equal(state.oldChecks,330)
      assert.equal(json("SELECT count(*) FROM private.work_items w JOIN pipeline_night_lab.seeded_work s ON s.id=w.id WHERE s.attempts=1 AND w.attempts=2;"),8)
      assert.equal(state.dueRequests,0)
      const forecasts=json('SELECT jsonb_agg(to_jsonb(f)) FROM public.matchup_forecasts f;')
      for(const forecast of forecasts)assert.deepEqual(forecast.forecast,computeForecast(cleanContext(literal(forecast.matchup_id))))
      writeFileSync(path.join(lane,'evidence/worker-native.json'),JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),state,calls,events,workerLog,forecastsCompared:forecasts.length,modeledOtherWorkers:true},null,2)+'\n')
      break
    }
    assert.ok(tick<1000,'Replay did not drain')
    if(!jobs.length)await pause(1000)
  }
}finally{
  if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await new Promise(resolve=>worker.once('exit',resolve))}
  await new Promise(resolve=>api.close(resolve))
  writeFileSync(path.join(lane,'evidence/worker-native.log'),workerLog)
  sql("UPDATE private.work_items SET status='succeeded',completed_at=now(),lease_token=NULL,lease_until=NULL WHERE key LIKE 'worker-holder-%'; DELETE FROM public.notification_outbox;")
}
