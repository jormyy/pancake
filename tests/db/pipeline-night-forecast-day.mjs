import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {Database,initialize} from './pipeline-night.mjs'
import {computeForecast} from '../../supabase/functions/matchup-forecast/compute.ts'

assert.equal(process.env.DOCKER_CONTEXT,'desktop-linux')
assert.equal(process.env.PIPELINE_LOCAL,'1')
const literal=value=>`'${String(value).replaceAll("'","''")}'`
const db=new Database()
const files=['private/enqueue_matchup_forecasts','private/enqueue_scheduled_work','private/complete_forecast_input_chunk','private/work_claim']
const baselineRef=process.env.PIPELINE_DAY_BASELINE_REF??'505d7734'
const baseline=files.map(file=>execFileSync('git',['show',`${baselineRef}:supabase/sql/functions/by-name/${file}.sql`],{encoding:'utf8'})).join('\n')
const freeze=source=>source.replace(/\b(now|clock_timestamp|transaction_timestamp)\(\)/g,'pg_temp.pipeline_now()').replace(/\bgen_random_uuid\(\)/g,'pg_temp.pipeline_uuid()')
const candidate=process.argv[2]?.includes('aa')?baseline:files.map(file=>readFileSync(`supabase/sql/functions/by-name/${file}.sql`,'utf8')).join('\n')
const report={mode:process.argv[2]??'candidate',baselineRef,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),phases:[]}
try{
 const fixture=await initialize(db)
 const main=literal(fixture.context.id),league=literal(fixture.context.league_id),game=literal(fixture.game.id)
 const rosterPlayer=await db.query(`SELECT player_id FROM public.roster_players WHERE league_season_id=${literal(fixture.context.league_season_id)} AND member_id IN(${literal(fixture.context.home_member_id)},${literal(fixture.context.away_member_id)}) ORDER BY player_id LIMIT 1;`)
 await db.query(`SET LOCAL pipeline.clock='2026-10-29T06:30:00Z'; UPDATE public.nba_games SET status='Scheduled',game_time='2026-10-29T23:00:00Z',started_at=NULL WHERE id=${game};
   UPDATE private.worker_controls SET paused=false,scheduler_level='normal' WHERE id;
   UPDATE private.matchup_forecast_queue SET claimed_at=NULL,claim_token=NULL,claimed_revision=NULL,claimed_fingerprint=NULL;
   DELETE FROM private.work_items; DELETE FROM public.notification_outbox; DELETE FROM public.edge_invocations;
   UPDATE private.notification_scan_state SET available_at=pg_temp.pipeline_now()+interval '2 days',scan_at=NULL; DELETE FROM private.notification_scan_dirty;
   UPDATE private.screen_refresh_queue SET dirty=false;
   SAVEPOINT day_base;`)
 const drain=async()=>{
  for(let n=0;n<1000;n++){
   const receipt=await db.json("SELECT public.run_scheduler_chunk('forecasts');")
   if(!receipt.remaining)return
  }
  throw new Error('Forecast scopes did not settle')
 }
 const worker=async()=>{
  const claims=await db.json("SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM public.claim_matchup_forecasts(25) c;")
  let completed=0
  for(const c of claims){
   const dates=await db.json(`SELECT public.prepare_matchup_forecast_inputs(${literal(c.matchup_id)});`)
   for(const date of dates)await db.query(`SELECT public.prepare_matchup_forecast_inputs(${literal(c.matchup_id)},${literal(date)});`)
   const context=await db.json(`SELECT public.get_prepared_matchup_forecast_context(${literal(c.matchup_id)});`)
   const forecast=computeForecast(context)
   const now=Date.parse(context.observedAt),tip=context.games.map(g=>Date.parse(g.game_time??'')).filter(t=>t>now).sort((a,b)=>a-b)[0]
   assert.equal(await db.query(`SELECT public.complete_matchup_forecast(${literal(c.matchup_id)},${c.revision},${literal(c.claim_token)},${literal(JSON.stringify(forecast))}::jsonb,${literal(new Date(Math.min(now+6*3600e3,tip??Infinity)).toISOString())});`),'t')
   completed++
  }
  return completed
 }
 for(const phase of process.env.PIPELINE_REVERSE==='1'?['candidate','baseline']:['baseline','candidate']){
  await db.query(`ROLLBACK TO day_base; ${freeze(phase==='baseline'?baseline:candidate)} SELECT pg_temp.pipeline_reset_sequences();`)
  const checkpoints=[];let computeCalls=0
  const checkpoint=async label=>{
   const values=await db.json(`SELECT jsonb_agg(public.get_matchup_forecast(f.matchup_id) ORDER BY f.matchup_id) FROM public.matchup_forecasts f WHERE f.league_id=${league};`)
   if(process.argv[2]==='control'&&phase==='candidate'&&label==='idle-end')values[0].stale=!values[0].stale
   checkpoints.push({label,values})
  }
  const tick=async()=>{
   await db.query('SELECT public.dispatch_work();')
   const jobs=await db.json("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'token',lease_token) ORDER BY id),'[]') FROM private.work_items WHERE status='running' AND key<>'forecast-held';")
   for(const job of jobs){
    if(job.kind==='forecast-inputs')await drain()
    if(job.kind==='matchup-forecasts')computeCalls+=await worker()
    await db.query(`SELECT private.work_finish(${job.id},${literal(job.token)});`)
   }
  }
  await db.query(`SELECT private.queue_matchup_forecasts(${league});`)
  await drain();computeCalls+=await worker()
  await db.query("UPDATE private.work_items SET status='succeeded',completed_at=pg_temp.pipeline_now() WHERE kind='matchup-forecasts' AND status IN('pending','failed');")
  if(process.argv[2]?.includes('blocked'))await db.query(`UPDATE public.players SET injury_status=CASE WHEN injury_status='Out' THEN 'Day-To-Day' ELSE 'Out' END WHERE id=${literal(rosterPlayer)};
    SELECT private.queue_matchup_forecasts(${league}); SELECT private.refresh_matchup_forecast_input(${main});
    INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
    VALUES('forecast-inputs','forecast-held','running',1,pg_temp.pipeline_uuid(),pg_temp.pipeline_now()+interval '2 hours','{"schedulerChunk":"forecasts"}');`)
  await checkpoint('morning')
  const idleStart=await db.json("SELECT jsonb_build_object('dirty',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty),'blocked',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty AND private.matchup_forecast_refresh_pending(matchup_id)),'leased',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty AND claimed_at>=pg_temp.pipeline_now()-interval '3 minutes'),'level',(SELECT scheduler_level FROM private.worker_controls WHERE id));")
  if(process.argv[2]?.includes('blocked')){assert.ok(idleStart.dirty>0);assert.ok(idleStart.blocked>0);assert.equal(idleStart.leased,0)}
  const before=await db.json("SELECT jsonb_build_object('work',(SELECT count(*) FROM private.work_items WHERE kind='matchup-forecasts'),'edge',(SELECT count(*) FROM public.edge_invocations WHERE function_name='matchup-forecast'));")
  for(let minute=0;minute<60;minute++){
   await db.query(`SET LOCAL pipeline.clock=${literal(new Date(Date.parse('2026-10-29T06:30:00Z')+minute*60000).toISOString())};`)
   await tick();await checkpoint(`idle-${minute}`)
  }
  const after=await db.json("SELECT jsonb_build_object('work',(SELECT count(*) FROM private.work_items WHERE kind='matchup-forecasts'),'edge',(SELECT count(*) FROM public.edge_invocations WHERE function_name='matchup-forecast'));")
  await checkpoint('idle-end')
  await db.query("UPDATE private.work_items SET status='succeeded',completed_at=pg_temp.pipeline_now(),lease_token=NULL,lease_until=NULL WHERE key='forecast-held';")
  const events=[
   ['six-hour-expiry','2026-10-29T12:30:00Z',''],
   ['lineup','2026-10-29T13:00:00Z',`UPDATE public.weekly_lineups SET is_auto_set=NOT is_auto_set WHERE ctid IN(SELECT ctid FROM public.weekly_lineups WHERE league_season_id=${literal(fixture.context.league_season_id)} AND member_id IN(${literal(fixture.context.home_member_id)},${literal(fixture.context.away_member_id)}) AND game_date>='2026-10-29' LIMIT 1); SELECT private.queue_matchup_forecasts(${league});`],
   ['injury','2026-10-29T13:05:00Z',`UPDATE public.players SET injury_status='Out' WHERE id=${literal(rosterPlayer)};`],
   ['projection','2026-10-29T13:10:00Z',`INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points,fetched_at) VALUES(${literal(rosterPlayer)},${fixture.context.season_year},${fixture.context.week_number},42,pg_temp.pipeline_now()) ON CONFLICT(player_id,season_year,week_number) DO UPDATE SET projected_stat_points=42,fetched_at=EXCLUDED.fetched_at;`],
   ['schedule','2026-10-29T14:00:00Z',`UPDATE public.nba_games SET game_time='2026-10-29T23:01:00Z' WHERE id=${game};`],
   ['before-tip','2026-10-29T23:00:59Z',''],
   ['tipoff','2026-10-29T23:01:00Z',`UPDATE public.nba_games SET status='InProgress',started_at=pg_temp.pipeline_now() WHERE id=${game};`],
   ['live','2026-10-29T23:05:00Z',`SELECT public.save_live_feed_snapshot_atomic(${game},${literal(fixture.game.nba_game_id)},${literal(JSON.stringify({source:'nba',source_updated_at:'2026-10-29T23:04:30Z',elapsed_seconds:300,status:'InProgress',home_score:12,away_score:11,status_text:'Q1',stats:fixture.stats}))}::jsonb); SELECT private.queue_matchup_forecasts(${league});`],
   ['final','2026-10-30T02:00:00Z',`UPDATE public.nba_games SET status='Final',stats_synced_at=pg_temp.pipeline_now() WHERE id=${game};`],
   ['midnight','2026-10-30T04:00:00Z',''],
   ['day-end','2026-10-30T06:30:00Z',''],
  ]
  for(const [label,time,change] of events){
   await db.query(`SET LOCAL pipeline.clock=${literal(time)}; ${change}`)
   await checkpoint(`${label}-pending`)
   await drain();computeCalls+=await worker();await tick()
   await checkpoint(label)
  }
  report.phases.push({phase,idleStart,idleWork:after.work-before.work,idleEdge:after.edge-before.edge,computeCalls,checkpoints})
 }
 const before=report.phases.find(row=>row.phase==='baseline'),after=report.phases.find(row=>row.phase==='candidate')
 assert.deepEqual(after.checkpoints,before.checkpoints,'User forecast checkpoint changed')
 report.pass=true
 report.checkpointCount=before.checkpoints.length
 report.checkpointSha256=createHash('sha256').update(JSON.stringify(before.checkpoints)).digest('hex')
 process.stdout.write(JSON.stringify({pass:true,checkpoints:report.checkpointCount,baselineIdle:before.idleWork,candidateIdle:after.idleWork})+'\n')
}finally{
 await db.query('ROLLBACK;');await db.close()
 writeFileSync(`/tmp/fable-l7/evidence/forecast-day-${process.argv[2]??'candidate'}.json`,JSON.stringify(report,null,2))
}
