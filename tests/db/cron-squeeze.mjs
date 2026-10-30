import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'
import { createSqlSession } from '../../scripts/season-sim/sql-session.mjs'
import { withMeasurementLock } from './perf-l4-measure-lock.mjs'

assert.equal(config.project,'pt4bafablel4')
assert.equal(config.prefix,'623')
assert.equal(await realpath(process.cwd()),path.join(miniRoot,'repo'))
const container='supabase_db_pt4bafablel4'
const directory=path.join(miniRoot,'evidence')
await mkdir(directory,{recursive:true})
await writeFile(path.join(directory,'cron-squeeze-owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}))
const q=value=>"'"+String(value).replaceAll("'","''")+"'"
const names=['private/work_execute','public/dispatch_work','private/queue_matchup_forecasts','private/enqueue_matchup_forecasts',
  'private/work_claim','public/notif_scan_due_atomic','public/claim_matchup_forecasts','public/complete_matchup_forecast','public/get_matchup_forecast']
const baseline=names.map(name=>execFileSync('git',['show',`892b6bca:supabase/sql/functions/by-name/${name}.sql`],{encoding:'utf8'})).join('\n')
const drops=[['queue_live_matchup_refresh','matchups'],['notification_scan_hint','league_change_hints'],
  ['notification_scan_game_insert','nba_games'],['notification_scan_game_change','nba_games'],
  ['notification_scan_player_change','players'],['notification_scan_draft_timer','snake_draft_picks'],
    ['requeue_deleted_matchup_forecast','private.matchup_forecast_queue'],['queue_matchup_forecast_expiry','matchup_forecasts'],
    ...[['matchups','matchups'],['lineups','weekly_lineups'],['rosters','roster_players'],['templates','lineup_slot_templates'],
      ['members','league_members'],['seasons','league_seasons'],['leagues','leagues'],['memberships','private.player_game_memberships']]
      .map(([name,table])=>['notification_scan_'+name,table])]
  .map(([trigger,table])=>`DROP TRIGGER ${trigger} ON ${table.includes('.')?table:'public.'+table};`).join('\n')
const rows=[]
const report={baseline:'892b6bca',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  cpu:0.25,memoryBytes:1073741824,pairs:5,ticksPerTrial:10,scope:'SQL cron commands and worker RPCs; Edge execution excluded',rows}
const save=()=>writeFile(path.join(directory,'cron-squeeze.json'),JSON.stringify(report,null,2))
const stop=()=>execFileSync('supabase',['stop','--project-id',config.project],{stdio:'ignore',timeout:120000})
let interrupted=false
process.once('SIGTERM',()=>{interrupted=true})
process.once('SIGINT',()=>{interrupted=true})
stop()
await withMeasurementLock(path.resolve(miniRoot,'../../shared/measure.lock'),'fable-l4',async()=>{
  let session
  try{
    execFileSync('supabase',['start','--exclude','gotrue,postgrest,kong,realtime,storage-api,studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'],{stdio:['ignore','pipe','pipe'],timeout:180000})
    execFileSync('docker',['update','--cpus','0.25','--memory','1g','--memory-swap','1g',container],{stdio:'ignore'})
    const host=JSON.parse(execFileSync('docker',['inspect','--format','{{json .HostConfig}}',container],{encoding:'utf8'}))
    assert.equal(host.NanoCpus,250000000)
    assert.equal(host.Memory,1073741824)
    session=createSqlSession('docker',process.env,['exec','-i',container,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'])
    const sql=statement=>session.query(statement)
    await sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; ALTER SYSTEM SET pg_stat_statements.track='all'; SELECT pg_reload_conf()")
    assert.equal(await sql('SHOW cron.launch_active_jobs'),'off')
    await sql("INSERT INTO private.forecast_input_revisions(kind,revision) VALUES('source',1) ON CONFLICT DO NOTHING")
    assert.equal(await sql("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='net.http_request_queue'::regclass AND tgname='perf_lab_local_http' AND tgenabled<>'D')"),'t')
    const jobs=JSON.parse(await readFile(path.join(miniRoot,'cron-jobs.json'),'utf8')).filter(job=>['io-hint-drain','work-dispatcher'].includes(job.jobname))
    assert.equal(jobs.length,2)
    await sql(`CREATE FUNCTION pg_temp.measure_chunk(command text) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE plan jsonb; started timestamptz:=clock_timestamp();
      BEGIN
        EXECUTE 'EXPLAIN(ANALYZE,BUFFERS,WAL,FORMAT JSON) '||command INTO plan;
        RETURN jsonb_build_object('status','pass','ms',(plan->0->>'Execution Time')::numeric,
          'planningMs',(plan->0->>'Planning Time')::numeric,
          'buffers',COALESCE((plan->0->'Plan'->>'Shared Hit Blocks')::bigint,0)+COALESCE((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0),
          'reads',COALESCE((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0),
          'walBytes',COALESCE((plan->0->'Plan'->>'WAL Bytes')::bigint,0));
      EXCEPTION WHEN query_canceled OR OTHERS THEN
        RETURN jsonb_build_object('status','fail','ms',extract(epoch FROM clock_timestamp()-started)*1000,'error',SQLERRM,'sqlstate',SQLSTATE);
      END; $$`)
    for(let pair=1;pair<=5;pair++)for(const variant of pair%2?['before','after']:['after','before']){
      assert.ok(!interrupted,'Squeeze measurement interrupted')
      await sql('BEGIN')
      try{
        if(variant==='before')await sql(baseline+'\n'+drops)
        await sql("SET LOCAL app.supabase_url='http://127.0.0.1:62381'; SET LOCAL app.edge_internal_token='offline-squeeze';")
        for(let tick=0;tick<10;tick++){
          assert.ok(!interrupted,'Squeeze measurement interrupted')
          const at=Date.parse('2025-10-25T00:50:00Z')+tick*60000
          await sql('RESET ROLE')
          await sql(`UPDATE season_sim.clock SET sim_ms=${at},rate=0,cap_ms=NULL WHERE singleton;
            UPDATE private.work_items SET status='succeeded',completed_at=now(),lease_token=NULL,lease_until=NULL WHERE status IN('pending','running','failed');
            UPDATE public.edge_invocations SET worker_status='succeeded',worker_finished_at=clock_timestamp(),reconciled_at=clock_timestamp() WHERE worker_status IN('pending','running');
            UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_checked_at=NULL,scheduler_healthy_since=NULL WHERE id;
            INSERT INTO private.player_stats_hint_pending(league_id) SELECT id FROM public.leagues WHERE deleted_at IS NULL AND status='active' ON CONFLICT DO NOTHING;
            UPDATE public.league_change_hints SET updated_at=clock_timestamp()-interval '2 minutes' WHERE topic='score';`)
          if(pair===1&&variant==='before'&&tick===0){
            report.shape=JSON.parse(await sql("SELECT json_build_object('leagues',(SELECT count(*) FROM public.leagues WHERE status='active' AND deleted_at IS NULL),'members',(SELECT count(*) FROM public.league_members),'liveGames',(SELECT count(*) FROM public.nba_games WHERE status='InProgress' AND game_date=(now() AT TIME ZONE 'America/New_York')::date))"))
            assert.equal(report.shape.leagues,1)
            assert.equal(report.shape.members,10)
            assert.ok(report.shape.liveGames>=2)
          }
          await sql('SET LOCAL ROLE postgres')
          const publication="UPDATE public.matchups SET home_points=COALESCE(home_points,0)+1 WHERE week_number=1 AND league_season_id IN(SELECT id FROM public.league_seasons WHERE is_current)"
          await sql('CREATE OR REPLACE FUNCTION pg_temp.cron_command() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE '+q(publication)+'; END $body$')
          await sql("SET LOCAL statement_timeout='5s'")
          const published=JSON.parse(await sql("SELECT pg_temp.measure_chunk('SELECT pg_temp.cron_command()')"))
          rows.push({pair,variant,tick,kind:'score-publication',...published})
          await save()
          assert.equal(published.status,'pass','Score publication failed')
          for(const job of jobs){
            await sql('CREATE OR REPLACE FUNCTION pg_temp.cron_command() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE '+q(job.command)+'; END $body$')
            await sql("SET LOCAL statement_timeout='5s'")
            const value=JSON.parse(await sql("SELECT pg_temp.measure_chunk('SELECT pg_temp.cron_command()')"))
            rows.push({pair,variant,tick,kind:job.jobname,...value})
            await save()
            if(variant==='after')assert.equal(value.status,'pass',`${job.jobname} failed`)
          }
          await sql('RESET ROLE')
          if(variant==='after')for(const [kind,due] of [['forecasts','EXISTS(SELECT 1 FROM private.forecast_refresh_requests WHERE available_at<=now()) OR EXISTS(SELECT 1 FROM private.matchup_forecast_expiries WHERE available_at<=now())'],
            ['notifications','EXISTS(SELECT 1 FROM private.notification_scan_state WHERE id AND (available_at<=now() OR scan_at IS NOT NULL)) OR EXISTS(SELECT 1 FROM private.notification_scan_dirty)']]){
            for(let chunk=0;;chunk++){
              await new Promise(resolve=>setTimeout(resolve,100))
              if(await sql('SELECT '+due)!=='t')break
              assert.ok(chunk<128,'Worker chunks did not drain')
              await sql("SET LOCAL statement_timeout='200ms'")
              const value=JSON.parse(await sql('SELECT pg_temp.measure_chunk('+q('SELECT public.run_scheduler_chunk('+q(kind)+')')+')'))
              rows.push({pair,variant,tick,kind,chunk,...value})
              await save()
              assert.equal(value.status,'pass',`${kind} statement exceeded its worker cap`)
            }
          }
          await sql("SET LOCAL statement_timeout='5s'")
        }
      }finally{await sql('ROLLBACK')}
      console.log(JSON.stringify({pair,variant,rows:rows.length}))
    }
    report.summary=[...new Set(rows.map(row=>row.variant+':'+row.kind))].map(key=>{
      const selected=rows.filter(row=>row.variant+':'+row.kind===key)
      const sorted=selected.map(row=>row.ms).sort((a,b)=>a-b)
      return {key,calls:selected.length,failures:selected.filter(row=>row.status!=='pass').length,
        meanMs:sorted.reduce((sum,value)=>sum+value,0)/sorted.length,p95Ms:sorted[Math.ceil(sorted.length*0.95)-1],maxMs:sorted.at(-1),
        meanBuffers:selected.reduce((sum,row)=>sum+(row.buffers??0),0)/selected.length,
        meanWalBytes:selected.reduce((sum,row)=>sum+(row.walBytes??0),0)/selected.length}
    })
    report.complete=true
    report.passed=report.summary.filter(row=>row.key.startsWith('after:')).every(row=>row.failures===0)
      && report.summary.filter(row=>row.key.startsWith('after:')&&['io-hint-drain','work-dispatcher'].includes(row.key.split(':')[1])).every(row=>row.maxMs<1000)
    await save()
    assert.ok(report.summary.filter(row=>row.key.startsWith('after:')).every(row=>row.failures===0))
    assert.ok(report.summary.filter(row=>row.key.startsWith('after:')&&['io-hint-drain','work-dispatcher'].includes(row.key.split(':')[1])).every(row=>row.maxMs<1000),'Minute cron must stay below one second during the squeeze')
    console.log(JSON.stringify(report.summary,null,2))
  }finally{await session?.close();stop()}
},async ms=>{
  assert.ok(!interrupted,'Squeeze measurement interrupted')
  await new Promise(resolve=>setTimeout(resolve,ms))
  assert.ok(!interrupted,'Squeeze measurement interrupted')
})
