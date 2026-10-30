import assert from 'node:assert/strict'
import {execFileSync,spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {setTimeout as pause} from 'node:timers/promises'
import {computeForecast} from '../../supabase/functions/matchup-forecast/compute.ts'

assert.equal(process.env.DOCKER_CONTEXT,'desktop-linux')
assert.equal(process.versions.node.split('.')[0],'22')
const url='postgresql://postgres:postgres@127.0.0.1:64822/postgres'
const literal=value=>`'${String(value).replaceAll("'","''")}'`
const sql=input=>execFileSync('psql',[url,'-XqAtv','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:16*1024*1024}).trim()
const json=input=>JSON.parse(sql(input))
const mode=process.argv[2]??'normal'
const applyRepair=()=>{for(const file of ['20261214005406_forecast_input_recovery.sql','20261214005407_forecast_ready_priority.sql'])sql(readFileSync(`supabase/migrations/${file}`,'utf8'))}
const results=[],rpcCalls=[],repairControls={}
let worker,workerLog='',chunkCalls=0,interrupted=false,restarted=false,parityChecks=0
const cleanContext=id=>json(`SELECT private.compute_matchup_forecast_context(${id})||jsonb_build_object('seasonAverages',coalesce((SELECT jsonb_agg(jsonb_build_object('player_id',a.player_id,'avg_fantasy_points',a.avg_fantasy_points) ORDER BY a.player_id) FROM public.v_player_avg_fantasy_points a JOIN public.matchups m ON m.id=${id} JOIN public.league_seasons s ON s.id=m.league_season_id WHERE a.league_id=m.league_id AND a.season_year=s.season_year AND a.player_id IN(SELECT player_id FROM public.roster_players r WHERE r.league_season_id=m.league_season_id AND r.member_id IN(m.home_member_id,m.away_member_id))),'[]'::jsonb));`)
const completeBatch=(limit,check)=>{
 const claims=json(`SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM public.claim_matchup_forecasts(${limit}) c;`)
 for(const claim of claims){
  const id=literal(claim.matchup_id),dates=json(`SELECT public.prepare_matchup_forecast_inputs(${id});`)
  for(const date of dates)sql(`SELECT public.prepare_matchup_forecast_inputs(${id},${literal(date)});`)
  const context=json(`SELECT public.get_prepared_matchup_forecast_context(${id});`),forecast=computeForecast(context)
  const now=Date.parse(context.observedAt),tip=context.games.map(g=>Date.parse(g.game_time??'')).filter(t=>t>now).sort((a,b)=>a-b)[0]
  assert.equal(sql(`SELECT public.complete_matchup_forecast(${id},${claim.revision},${literal(claim.claim_token)},${literal(JSON.stringify(forecast))}::jsonb,${literal(new Date(Math.min(now+6*3600e3,tip??Infinity)).toISOString())});`),'t')
  if(check){
   if(process.env.PIPELINE_RECOVERY_CONTROL==='1')forecast.status='injected-failure'
   assert.deepEqual(forecast,computeForecast(cleanContext(id)),'Recovered forecast differs from clean recompute');parityChecks++
  }
 }
 return claims.length
}
const allowed=new Set(['run_scheduler_chunk','start_edge_invocation','renew_work_lease','finish_edge_invocation'])
const api=createServer(async(req,res)=>{
 try{
  const name=req.url.split('/').at(-1)
  assert.ok(allowed.has(name));assert.equal(req.method,'POST')
  let text='';for await(const part of req)text+=part
  const args=JSON.parse(text),headers=JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([name])=>name==='x-pancake-work-key')))
  const value=sql(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL request.headers=${literal(headers)}; SELECT coalesce(to_jsonb(public.${name}(${Object.entries(args).map(([key,value])=>`${key}=>${typeof value==='boolean'?value:value===null?'NULL':typeof value==='number'?value:literal(value)}`).join(',')})),'null'); COMMIT;`)
  rpcCalls.push({name,...args,value:JSON.parse(value)})
  res.writeHead(200,{'content-type':'application/json'});res.end(value)
  if(name==='run_scheduler_chunk'&&!args.p_requeue&&++chunkCalls===8&&mode.startsWith('restart')){
   interrupted=true;worker.kill('SIGKILL')
  }
 }catch(error){
  res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({code:'P0001',message:String(error.stderr??error.message).slice(-3000)}))
 }
})
await new Promise(resolve=>api.listen(64839,'127.0.0.1',resolve))
const startWorker=async()=>{
 worker=spawn('deno',['run','--cached-only','--no-check','--no-config','--allow-net=127.0.0.1:64838,127.0.0.1:64839','--allow-env','tests/db/pipeline-night-input-edge.mjs'],{
  env:{...process.env,SUPABASE_URL:'http://127.0.0.1:64839',PANCAKE_SUPABASE_SECRET_KEY:'sb_secret_pipeline_fixture',PANCAKE_EDGE_INTERNAL_TOKEN:'private-pipeline-night'},stdio:['ignore','pipe','pipe']})
 worker.stdout.on('data',part=>{workerLog+=part});worker.stderr.on('data',part=>{workerLog+=part})
 for(let attempt=0;attempt<100;attempt++){
  if(worker.exitCode!==null)throw new Error(workerLog)
  try{await fetch('http://127.0.0.1:64838');break}catch{await pause(100)}
 }
}
try{
 await startWorker()
 if(mode==='load-repair')for(const name of ['private/enqueue_matchup_forecasts','private/enqueue_scheduled_work','private/complete_forecast_input_chunk'])sql(execFileSync('git',['show',`c84063c4:supabase/sql/functions/by-name/${name}.sql`],{encoding:'utf8'}))
 sql(`SET app.supabase_url='http://127.0.0.1:64821'; SET app.edge_internal_token='private-pipeline-night';
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
    SELECT league_id,league_season_id,week_number,away_member_id,home_member_id FROM public.matchups ORDER BY id LIMIT 2 ON CONFLICT DO NOTHING;
  DELETE FROM private.work_items; DELETE FROM public.edge_invocations; DELETE FROM public.notification_outbox;
  UPDATE public.trades SET expires_at=now()+interval '1 day' WHERE status='pending';
  UPDATE public.trades SET veto_window_expires_at=now()+interval '1 day' WHERE status='accepted';
  UPDATE public.nba_games SET status='Final',stats_synced_at=now() WHERE game_date<(now() AT TIME ZONE 'America/New_York')::date;
  UPDATE public.sync_jobs SET status='completed',completed_at=now() WHERE job_type LIKE 'sync_stats_range:%' AND status IN('pending','running','failed');
  UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_checked_at=NULL,scheduler_healthy_since=NULL WHERE id;
  UPDATE private.screen_refresh_queue SET dirty=false;
  UPDATE private.notification_scan_state SET available_at=now()+interval '1 day'; DELETE FROM private.notification_scan_dirty;
  DELETE FROM private.forecast_refresh_requests; DELETE FROM private.matchup_forecast_expiries;
  UPDATE private.matchup_forecast_queue SET dirty=true,claimed_at=NULL,claim_token=NULL,claimed_revision=NULL,
    available_at=now(),input_fingerprint=private.matchup_forecast_input_fingerprint(matchup_id);`)
 for(let batch=0;batch<4;batch++)if(completeBatch(25,process.env.PIPELINE_RECOVERY_CONTROL==='1')===0)break
 sql(`UPDATE public.players SET injury_status=CASE WHEN injury_status='Out' THEN 'Day-To-Day' ELSE 'Out' END WHERE id=(
    SELECT r.player_id FROM public.roster_players r WHERE (SELECT count(*) FROM private.matchup_forecast_queue q JOIN public.matchups m ON m.id=q.matchup_id WHERE m.league_season_id=r.league_season_id AND r.member_id IN(m.home_member_id,m.away_member_id))=3 ORDER BY r.player_id LIMIT 1);
  DELETE FROM private.forecast_refresh_requests; DELETE FROM private.matchup_forecast_expiries;
  INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
    SELECT 'matchup:'||id,id,'2026-10-30T06:19:16.613194Z' FROM public.matchups ORDER BY id LIMIT 82;
  WITH changed AS MATERIALIZED(SELECT matchup_id,private.matchup_forecast_input_fingerprint(matchup_id) AS fingerprint FROM private.matchup_forecast_queue)
  UPDATE private.matchup_forecast_queue q SET dirty=true,available_at='2026-10-30T06:13:00Z',changed_at='2026-10-30T06:13:00Z',revision=revision+1,input_fingerprint=c.fingerprint
    FROM changed c WHERE q.matchup_id=c.matchup_id AND q.computed_fingerprint->>'inputs' IS DISTINCT FROM c.fingerprint->>'inputs';
  UPDATE private.screen_refresh_queue SET dirty=false;
  UPDATE private.notification_scan_state SET available_at=now()+interval '1 day'; DELETE FROM private.notification_scan_dirty;
  DELETE FROM public.notification_outbox;`)
 assert.equal(json('SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty;'),3)
 if(mode==='restart-final')sql("INSERT INTO private.work_items(kind,key,status,attempts,payload) VALUES('forecast-inputs','interrupted-final-attempt','pending',2,'{\"schedulerChunk\":\"forecasts\"}');")
 if(mode==='load-repair'){
  sql(`INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
    SELECT 'stats-sync','foreground-holder-'||n,'running',1,gen_random_uuid(),now()+interval '5 minutes',jsonb_build_object('holder',n) FROM generate_series(1,2) n;
    INSERT INTO private.work_items(kind,key,status,attempts,due_at,payload) VALUES('forecast-inputs','old-backoff','failed',1,now()+interval '15 minutes','{"schedulerChunk":"forecasts"}');
    SELECT private.work_enqueue('matchup-forecasts','legacy-empty-worker',now());
    INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload) VALUES('forecast-inputs','healthy-lease-control','running',1,gen_random_uuid(),now()+interval '5 minutes','{"schedulerChunk":"forecasts","control":true}');`)
  applyRepair()
  assert.equal(json("SELECT count(*) FROM private.work_items WHERE key='forecast-input-recovery:20261214005406';"),0)
  assert.equal(json("SELECT count(*) FROM private.work_items WHERE key='healthy-lease-control' AND status='running' AND lease_until>now();"),1)
  assert.equal(json("SELECT count(*) FROM private.work_items WHERE key='old-backoff' AND due_at>now() AND attempts=1;"),1)
  repairControls.liveLeasePreserved=true
  sql("DELETE FROM private.work_items WHERE key='healthy-lease-control';")
  applyRepair()
  assert.equal(json("SELECT count(*) FROM private.work_items WHERE key='forecast-input-recovery:20261214005406' AND status='pending';"),1)
  assert.equal(json("SELECT count(*) FROM private.work_items WHERE key='old-backoff' AND status='failed' AND due_at<=now() AND attempts=1;"),1)
  repairControls.retryMadeDueWithoutResettingAttempts=true
  applyRepair()
  assert.equal(json("SELECT count(*) FROM private.work_items WHERE key='forecast-input-recovery:20261214005406';"),1)
  repairControls.idempotent=true
 }
 assert.equal(json("SELECT count(*) FROM private.forecast_refresh_requests WHERE available_at<=now();"),82)
 if(mode==='load-repair')repairControls.requestsRetained=true
 const before=json("SELECT jsonb_build_object('due',count(*),'timestamps',count(DISTINCT available_at)) FROM private.forecast_refresh_requests WHERE available_at<=now();")
 for(let tick=1;tick<=8;tick++){
  if(tick>1)await pause(60005-Date.now()%60000)
  if(mode==='load-repair')sql(`SET app.supabase_url='http://127.0.0.1:64821'; SET app.edge_internal_token='private-pipeline-night';
    UPDATE private.work_items SET lease_until=now()+interval '5 minutes' WHERE key LIKE 'foreground-holder-%';
    SELECT private.enqueue_scheduled_work(now());
    UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE kind NOT IN('forecast-inputs','matchup-forecasts') AND status IN('pending','failed');`)
  sql("SET app.supabase_url='http://127.0.0.1:64821'; SET app.edge_internal_token='private-pipeline-night'; SELECT public.dispatch_work();")
  const jobs=json("SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') FROM private.work_items w WHERE status='running' AND key NOT LIKE 'foreground-holder-%';")
  for(const job of jobs){
   if(job.kind==='forecast-inputs'){
    try{
     const response=await fetch('http://127.0.0.1:64838',{method:'POST',headers:{'content-type':'application/json','x-internal-function-token':'private-pipeline-night','x-pancake-invocation-id':job.invocation_key,'x-pancake-work-id':String(job.id)},body:JSON.stringify(job.payload)})
     const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));results.push({tick,kind:job.kind,...value})
    }catch(error){if(!interrupted||restarted)throw error;results.push({tick,kind:job.kind,workerKilledAfterCommittedChunks:8})}
   }else if(job.kind==='matchup-forecasts'){
    const completed=completeBatch(10,true)
    sql(`SELECT private.work_finish(${job.id},${literal(job.lease_token)});`);results.push({tick,kind:job.kind,completed})
   }else{
    if(job.kind==='process-trades')sql('DELETE FROM public.notification_outbox;')
    sql(`SELECT private.work_finish(${job.id},${literal(job.lease_token)});`)
   }
  }
  if(interrupted&&!restarted){
   if(worker.exitCode===null&&worker.signalCode===null)await new Promise(resolve=>worker.once('exit',resolve))
   const saved=json("SELECT count(*) FROM private.forecast_refresh_requests WHERE available_at<=now();")
   execFileSync('docker',['--context','desktop-linux','restart','supabase_db_pt4bafablel7'],{encoding:'utf8'})
   for(let attempt=0;attempt<60;attempt++){try{sql('SELECT 1;');break}catch{await pause(1000)}}
   assert.equal(json("SELECT count(*) FROM private.forecast_refresh_requests WHERE available_at<=now();"),saved)
   const active=json("SELECT count(*) FROM private.work_items WHERE kind='forecast-inputs' AND status='running' AND lease_until>now();")
   assert.equal(active,1)
   sql("UPDATE private.work_items SET lease_until=now()-interval '1 second' WHERE kind='forecast-inputs' AND status='running';")
   results.push({tick,databaseRestarted:true,committedRequestsPreserved:saved,simulatedLeaseExpiry:true})
   restarted=true;await startWorker()
  }
  const state=json("SELECT jsonb_build_object('due',(SELECT count(*) FROM private.forecast_refresh_requests WHERE available_at<=now()),'dirty',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty),'blocked',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty AND private.matchup_forecast_refresh_pending(matchup_id))); ")
  results.push({tick,...state});process.stdout.write(JSON.stringify({tick,...state})+'\n')
  if(state.due===0&&state.dirty===0)break
 }
 const after=results.at(-1)
 const cached=json("SELECT jsonb_agg(to_jsonb(f)) FROM public.matchup_forecasts f;")
 for(const row of cached)assert.deepEqual(row.forecast,computeForecast(cleanContext(literal(row.matchup_id))),'Cached forecast differs from clean recompute')
 writeFileSync(`/tmp/fable-l7/evidence/input-recovery-${mode}.json`,JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),migrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/20261214005406_forecast_input_recovery.sql')).digest('hex'),priorityMigrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/20261214005407_forecast_ready_priority.sql')).digest('hex'),before,after,repairControls,parityChecks,allCachedForecastsCompared:cached.length,results,rpcCalls,workerLog},null,2)+'\n')
 assert.equal(after.due,0);assert.equal(after.dirty,0)
}finally{
 if(mode==='load-repair'){
  sql("UPDATE private.work_items SET status='succeeded',completed_at=now(),lease_token=NULL,lease_until=NULL WHERE key LIKE 'foreground-holder-%';")
  for(const name of ['private/enqueue_matchup_forecasts','private/enqueue_scheduled_work','private/complete_forecast_input_chunk'])sql(readFileSync(`supabase/sql/functions/by-name/${name}.sql`,'utf8'))
 }
 if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await new Promise(resolve=>worker.once('exit',resolve))}
 await new Promise(resolve=>api.close(resolve))
 writeFileSync('/tmp/fable-l7/evidence/input-recovery-worker.log',workerLog)
}
