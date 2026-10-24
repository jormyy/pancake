import { strict as assert } from 'node:assert'


Deno.test({ name: 'retention statements use indexes on populated local tables', ignore: !Deno.args.includes('--local-db'), fn: async () => {
  const db = Deno.env.get('SUPABASE_DB_URL')!
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(db).hostname))
  const source = await Deno.readTextFile(new URL('../../sql/functions/by-name/public/prune_unbounded_history.sql', import.meta.url))
  const logDeletes = [...source.matchAll(/WITH victims AS \([\s\S]*?\) DELETE FROM public\.(sync_runs|edge_invocations) r USING victims v WHERE r.id=v.id;/g)].map((match) => match[0])
  assert.equal(logDeletes.length, 4)
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
  const plans = logDeletes.map((statement, index) => `SELECT pg_temp.check_plan(${quoted(statement)},${quoted(['sync_runs_retention_success', 'sync_runs_retention_failed', 'edge_invocations_retention_success', 'edge_invocations_retention_failed'][index])});`)
  plans.push(`SELECT pg_temp.check_plan('SELECT runid FROM cron.job_run_details WHERE runid>0 ORDER BY runid LIMIT 1000','job_run_details_pkey');`)
  plans.push(`SELECT pg_temp.check_plan('SELECT id FROM public.sleeper_projection_rows WHERE game_date<current_date-7 ORDER BY game_date,id LIMIT 10000','sleeper_projection_rows_date');`)
  plans.push(`SELECT pg_temp.check_plan('SELECT id FROM public.fantasypros_projection_rows WHERE run_id=''11111111-0000-0000-0000-000000000001'' ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED','fantasypros_projection_rows_run');`)
  plans.push(`SELECT pg_temp.check_plan('SELECT id FROM public.projection_sync_runs WHERE projection_period_end<current_date-7 ORDER BY projection_period_end,id LIMIT 200','projection_sync_runs_retention_period');`)
  const completion = await Deno.readTextFile(new URL('../../sql/functions/by-name/public/complete_sleeper_projection_sync.sql', import.meta.url))
  const snapshotDelete = completion.match(/DELETE FROM public\.sleeper_projection_rows stored[\s\S]*?;/)?.[0]
  assert.ok(snapshotDelete)
  const scopedDelete = snapshotDelete.replaceAll('v_run.season_year', '2097').replaceAll('v_run.week_number', '2').replaceAll('p_rows', "'[]'::jsonb").replaceAll('v_source_keys', "'[]'::jsonb")
  plans.push(`SELECT pg_temp.check_plan(${quoted(scopedDelete)},'sleeper_projection_rows_week');`)
  const sql = `BEGIN;
  SET LOCAL statement_timeout='30s';
  CREATE TEMP TABLE retention_plans(plan jsonb);
  CREATE FUNCTION pg_temp.check_plan(statement text,expected_index text) RETURNS void LANGUAGE plpgsql AS $$
  DECLARE plan jsonb;
  BEGIN
    EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '||statement INTO plan;
    IF position(expected_index IN plan::text)=0 THEN RAISE EXCEPTION 'Expected index % missing from %',expected_index,plan; END IF;
    INSERT INTO retention_plans VALUES(plan);
  END;
  $$;
  INSERT INTO public.sync_runs(function_name,started_at,finished_at,status,error)
  SELECT 'index-fixture-'||(n%100),now()-interval '1 hour',now()-interval '1 hour',
    CASE WHEN n%2=0 THEN 'success' ELSE 'failed' END,CASE WHEN n%2=0 THEN NULL ELSE 'fixture' END
  FROM generate_series(1,50000) n;
  INSERT INTO public.sync_runs(function_name,started_at,finished_at,status,error)
  SELECT 'index-fixture-'||(n%100),now()-interval '40 days',now()-interval '40 days',
    CASE WHEN n%2=0 THEN 'success' ELSE 'failed' END,CASE WHEN n%2=0 THEN NULL ELSE 'fixture' END
  FROM generate_series(1,400) n;
  INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,error_message)
  SELECT 'index-fixture-'||(n%100),now()-interval '1 hour',now()-interval '1 hour',
    CASE WHEN n%2=0 THEN 200 ELSE 500 END,CASE WHEN n%2=0 THEN NULL ELSE 'fixture' END
  FROM generate_series(1,50000) n;
  INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,error_message)
  SELECT 'index-fixture-'||(n%100),now()-interval '40 days',now()-interval '40 days',
    CASE WHEN n%2=0 THEN 200 ELSE 500 END,CASE WHEN n%2=0 THEN NULL ELSE 'fixture' END
  FROM generate_series(1,400) n;
  INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,worker_status,worker_started_at)
  SELECT 'index-fixture-'||(n%100),now()-interval '40 days',now()-interval '40 days',200,'failed',now()-interval '40 days'
  FROM generate_series(1,400) n;
  INSERT INTO cron.job_run_details(jobid,runid,status,start_time,end_time)
  SELECT 9999999,2000000000+n,'succeeded',now()-interval '1 hour',now()-interval '1 hour' FROM generate_series(1,10000) n;
  INSERT INTO public.players(id,first_name,last_name,position) VALUES('11111111-0000-0000-0000-000000000002','Index','Fixture','PG');
  INSERT INTO public.sleeper_projection_rows(player_id,source_game_id,sleeper_id,season_year,week_number,game_date,team,opponent,
    points,rebounds,assists,steals,blocks,three_pointers_made,turnovers,field_goals_made,field_goals_attempted,
    free_throws_made,free_throws_attempted,three_pointers_attempted,minutes,last_modified)
  SELECT '11111111-0000-0000-0000-000000000002',n::text,'index-fixture',2097,CASE WHEN n>9980 THEN 2 ELSE 1 END,
    CASE WHEN n<=20 THEN current_date-14 ELSE current_date END,'BOS','NYK',0,0,0,0,0,0,0,0,0,0,0,0,0,1
  FROM generate_series(1,10000) n;
  INSERT INTO public.projection_sync_runs(id,projection_type,source_url,projection_date)
  VALUES('11111111-0000-0000-0000-000000000001','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',current_date-14);
  INSERT INTO public.projection_sync_runs(projection_type,source_url,projection_date)
  SELECT 'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',current_date FROM generate_series(1,10000);
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,fetched_at,source_player_name,normalized_player_name,match_status)
  SELECT '11111111-0000-0000-0000-000000000001','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',n,now(),'Fixture','fixture','unmatched' FROM generate_series(1,1000) n;
  ANALYZE public.sync_runs;
  ANALYZE public.edge_invocations;
  ANALYZE cron.job_run_details;
  ANALYZE public.sleeper_projection_rows;
  ANALYZE public.projection_sync_runs;
  ANALYZE public.fantasypros_projection_rows;
  ${plans.join('\n')}
  SELECT jsonb_build_object('passed',count(*),'plans',jsonb_agg(plan->0->'Plan'->'Node Type')) FROM retention_plans;
  ROLLBACK;`
  const command = new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-f', '-'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const input = command.stdin.getWriter()
  await input.write(new TextEncoder().encode(sql))
  await input.close()
  const output = await command.output()
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr))
  console.log(new TextDecoder().decode(output.stdout).trim())
} })
