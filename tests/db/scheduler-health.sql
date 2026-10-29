BEGIN;
\ir rules-support.sql
SELECT private.scheduler_health();
CREATE TEMP TABLE scheduler_runs(
  runid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jobid bigint,status text,start_time timestamptz,end_time timestamptz,return_message text
);
CREATE TEMP TABLE scheduler_executed(kind text);
DO $$
BEGIN
  EXECUTE replace(pg_get_functiondef('private.scheduler_health()'::regprocedure),
    'cron.job_run_details','pg_temp.scheduler_runs');
END;
$$;
CREATE FUNCTION pg_temp.scheduler_sample(p_success integer, p_total integer, p_duration numeric DEFAULT 0.5)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job bigint; v_at timestamptz:=clock_timestamp()-interval '1 minute';
BEGIN
  SELECT jobid INTO STRICT v_job FROM cron.job WHERE jobname='work-dispatcher';
  TRUNCATE scheduler_runs;
  INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
  SELECT v_job,CASE WHEN n<=p_success THEN 'succeeded' ELSE 'failed' END,
    v_at,v_at+p_duration*interval '1 second','SELECT 1'
  FROM generate_series(1,p_total) n;
  RETURN private.scheduler_health();
END;
$$;
CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO pg_temp.scheduler_executed SELECT kind FROM private.work_items WHERE id=p_id;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;
CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE OR REPLACE FUNCTION private.enqueue_process_trades(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE OR REPLACE FUNCTION private.enqueue_stats_sync_dispatch(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE OR REPLACE FUNCTION private.enqueue_live_poll(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
\if :{?scheduler_health_admit_heavy}
DO $$
BEGIN
  EXECUTE replace(pg_get_functiondef('public.dispatch_work()'::regprocedure),'AND kind=ANY(v_kinds)','');
END;
$$;
\endif
\if :{?scheduler_health_early_recovery}
DO $$
BEGIN
  EXECUTE replace(pg_get_functiondef('private.apply_scheduler_health(jsonb)'::regprocedure),
    'interval ''10 minutes''','interval ''9 minutes''');
END;
$$;
\endif
\if :{?scheduler_health_unbounded}
DO $$
BEGIN
  EXECUTE replace(pg_get_functiondef('private.scheduler_health()'::regprocedure),'LIMIT 40','');
END;
$$;
\endif
DO $$
DECLARE h jsonb; t timestamptz:=date_trunc('minute',clock_timestamp()); v_count bigint;
  v_kind text; v_level text; v_versions bigint; v_hints bigint;
BEGIN
  DELETE FROM private.scheduler_health_log;
  DELETE FROM public.scheduler_health_hint;
  UPDATE private.worker_controls SET paused=false,scheduler_level='normal',scheduler_healthy_since=NULL,
    scheduler_checked_at=NULL,scheduler_last_dispatch_at=NULL WHERE id;
  SELECT count(*) INTO v_versions FROM public.league_versions;
  SELECT count(*) INTO v_hints FROM public.league_change_hints;
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(pg_temp.scheduler_sample(0,0))='normal',
    'empty initial history leaves normal admission unchanged');
  h:=pg_temp.scheduler_sample(5,5);
  PERFORM pg_temp.check_rules((h->>'success_ratio')::numeric=1,'five successful samples are healthy');
  PERFORM pg_temp.check_rules(abs((h->>'avg_duration_seconds')::numeric-0.5)<0.01,'average duration uses seconds');
  PERFORM pg_temp.check_rules(abs((h->>'max_duration_seconds')::numeric-0.5)<0.01,'maximum duration uses seconds');
  PERFORM pg_temp.check_rules((h->>'active_backends')::int>=0 AND (h->>'lock_waiters')::int>=0,'backend counters are present');
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h)='normal','healthy startup stays normal');
  INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
  SELECT jobid,'failed',clock_timestamp()-interval '6 minutes',clock_timestamp(),
    'job startup timeout' FROM scheduler_runs LIMIT 1;
  INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
  SELECT jobid,'failed',clock_timestamp()+interval '1 minute',clock_timestamp(),
    'job startup timeout' FROM scheduler_runs LIMIT 1;
  INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
  VALUES(-1,'failed',clock_timestamp()-interval '1 minute',clock_timestamp(),'unrelated failure');
  h:=private.scheduler_health();
  PERFORM pg_temp.check_rules((h->>'samples')::int=5 AND (h->>'startup_timeouts')::int=0,
    'window excludes old and future failures and isolates dispatcher samples');
  h:=pg_temp.scheduler_sample(4,5,3);
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h)='normal','eighty percent and three seconds stay normal');
  h:=pg_temp.scheduler_sample(3,5);
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h)='shed','sixty percent sheds');
  SELECT count(*) INTO v_count FROM private.scheduler_health_log;
  PERFORM private.apply_scheduler_health(h);
  PERFORM pg_temp.check_rules((SELECT count(*)=v_count FROM private.scheduler_health_log),'unchanged state emits no duplicate log');
  h:=pg_temp.scheduler_sample(2,5);
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h)='paused','forty percent pauses heavy work');
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(jsonb_build_object('available',false,'checked_at',clock_timestamp()))='paused',
    'unavailable health preserves the stricter paused state');
  h:=pg_temp.scheduler_sample(5,5);
  FOR n IN 0..9 LOOP
    PERFORM pg_temp.check_rules(private.apply_scheduler_health(h||jsonb_build_object('checked_at',t+n*interval '1 minute'))='paused',
      'healthy minute '||n||' cannot recover early');
  END LOOP;
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h||jsonb_build_object('checked_at',t+interval '10 minutes'))='normal',
    'ten continuous healthy minutes recover');
  h:=pg_temp.scheduler_sample(5,5,3.1);
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h||jsonb_build_object('checked_at',t+interval '11 minutes'))='shed',
    'slow successful runs shed');
  h:=pg_temp.scheduler_sample(1,2);
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h)='shed','exactly fifty percent does not pause');
  h:=pg_temp.scheduler_sample(5,5);
  PERFORM private.apply_scheduler_health(h||jsonb_build_object('checked_at',t+interval '12 minutes'));
  PERFORM private.apply_scheduler_health(h||jsonb_build_object('checked_at',t+interval '22 minutes'));
  PERFORM pg_temp.check_rules((SELECT scheduler_level='shed' AND scheduler_healthy_since=t+interval '22 minutes'
    FROM private.worker_controls),'a missing check resets healthy time');
  h:=pg_temp.scheduler_sample(0,0);
  PERFORM private.apply_scheduler_health(h);
  PERFORM pg_temp.check_rules((SELECT scheduler_level='shed' AND scheduler_healthy_since IS NULL
    FROM private.worker_controls),'missing samples cannot recover');
  h:=pg_temp.scheduler_sample(5,5);
  INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
  VALUES(-1,'failed',clock_timestamp()-interval '1 minute',clock_timestamp(),'job startup timeout');
  h:=private.scheduler_health();
  PERFORM pg_temp.check_rules((h->>'startup_timeouts')::int=1,'startup failures include other cron jobs');
  PERFORM pg_temp.check_rules(private.apply_scheduler_health(h)='paused','any startup timeout pauses heavy work');
  PERFORM pg_temp.check_rules((SELECT count(*)=v_versions FROM public.league_versions)
    AND (SELECT count(*)=v_hints FROM public.league_change_hints),'state changes emit no league changes');
  PERFORM pg_temp.check_rules((SELECT level='paused' AND revision=(SELECT count(*) FROM private.scheduler_health_log)
    FROM public.scheduler_health_hint WHERE id),'admin hint matches transition log');
  PERFORM pg_temp.check_rules((SELECT array_agg(level ORDER BY id)=ARRAY['shed','paused','normal','shed','paused']
    FROM private.scheduler_health_log),'each transition records its new state exactly once');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon','public.get_scheduler_health()','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.get_scheduler_health()','EXECUTE')
    AND has_function_privilege('service_role','public.get_scheduler_health()','EXECUTE'),'health RPC is service only');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','public.scheduler_health_hint','SELECT'),
    'admin hint is not exposed to league members');
  PERFORM pg_temp.scheduler_sample(5,5);
  FOREACH v_level IN ARRAY ARRAY['normal','shed','paused'] LOOP
    DELETE FROM private.work_items;
    TRUNCATE scheduler_executed;
    UPDATE private.worker_controls SET scheduler_level=v_level,scheduler_healthy_since=NULL,
      scheduler_checked_at=NULL,scheduler_last_dispatch_at=NULL WHERE id;
    FOR v_kind IN SELECT kind FROM private.work_kinds WHERE retired_at IS NULL ORDER BY kind LOOP
      PERFORM private.work_enqueue(v_kind,'health-'||v_kind,now()-interval '1 day');
    END LOOP;
    FOR n IN 1..30 LOOP
      UPDATE private.worker_controls SET scheduler_last_dispatch_at=clock_timestamp()-interval '5 minutes' WHERE id;
      PERFORM public.dispatch_work();
    END LOOP;
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM scheduler_executed WHERE v_level<>'normal' AND kind<>ALL(
      CASE WHEN v_level='shed' THEN ARRAY['live-poll','sync-scores','stats-sync','process-waivers','process-trades','edge-invocation-reconcile']
      ELSE ARRAY['process-waivers','process-trades','live-poll'] END)),v_level||' runs only allowed kinds');
    PERFORM pg_temp.check_rules((SELECT count(DISTINCT kind) FROM scheduler_executed)=
      CASE v_level WHEN 'normal' THEN (SELECT count(*) FROM private.work_kinds WHERE retired_at IS NULL) WHEN 'shed' THEN 6 ELSE 3 END,
      v_level||' eventually runs every allowed kind');
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE status='pending' AND attempts<>0),
      v_level||' does not consume attempts for skipped work');
  END LOOP;
  DELETE FROM private.work_items;
  TRUNCATE scheduler_executed;
  UPDATE private.worker_controls SET scheduler_last_dispatch_at=NULL WHERE id;
  PERFORM private.work_enqueue('live-poll','cadence-1');
  PERFORM public.dispatch_work();
  PERFORM private.work_enqueue('live-poll','cadence-2');
  PERFORM pg_temp.check_rules(public.dispatch_work()=0,'paused mode waits five minutes between dispatches');
END;
$$;
TRUNCATE scheduler_runs;
INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
SELECT -1,'succeeded',now()-interval '1 day',now()-interval '1 day'+'0.5 seconds'::interval,'SELECT 1'
FROM generate_series(1,100000);
INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
SELECT jobid,'succeeded',now()-interval '1 minute',now()-interval '59.5 seconds','SELECT 1'
FROM cron.job CROSS JOIN generate_series(1,5) WHERE jobname='work-dispatcher';
ANALYZE scheduler_runs;
DO $$
DECLARE v_source text; v_query text; v_plan jsonb;
BEGIN
  v_source:=pg_get_functiondef('private.scheduler_health()'::regprocedure);
  v_query:=split_part(substr(v_source,position('WITH recent AS MATERIALIZED (' IN v_source)),';',1);
  v_query:=replace(replace(v_query,'INTO v_health',''),'v_now',quote_literal(clock_timestamp())||'::timestamptz');
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '||v_query INTO v_plan;
  RAISE NOTICE 'Health plan scan: % rows; execution: % ms',
    jsonb_path_query_first(v_plan,'$.** ? (@."Relation Name" == "scheduler_runs")."Actual Rows"'),
    v_plan->0->>'Execution Time';
  PERFORM pg_temp.check_rules(jsonb_path_exists(v_plan,
    '$.** ? (@."Relation Name" == "scheduler_runs" && @."Index Name" == "scheduler_runs_pkey" && @."Scan Direction" == "Backward")'),
    'health reads the existing primary key backward across 100000 old rows');
  PERFORM pg_temp.check_rules(NOT jsonb_path_exists(v_plan,
    '$.** ? (@."Relation Name" == "scheduler_runs" && @."Actual Rows" > 40)'),
    'health reads at most forty cron rows');
  PERFORM pg_temp.check_rules((private.scheduler_health()->>'samples')::int=5,
    'bounded history still includes all five dispatcher samples');
END;
$$;
DO $$
DECLARE v_job bigint; h jsonb;
BEGIN
  SELECT jobid INTO STRICT v_job FROM cron.job WHERE jobname='work-dispatcher';
  TRUNCATE scheduler_runs;
  INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
  VALUES(v_job,'failed',now()-interval '1 minute',now(),'job startup timeout');
  INSERT INTO scheduler_runs(jobid,status,start_time,end_time,return_message)
  SELECT CASE WHEN n<=5 THEN v_job ELSE -1 END,'succeeded',
    now()-interval '1 minute',now()-interval '59.5 seconds','SELECT 1'
  FROM generate_series(1,40) n;
  h:=private.scheduler_health();
  PERFORM pg_temp.check_rules((h->>'rows_checked')::int=40 AND (h->>'samples')::int=5
    AND (h->>'startup_timeouts')::int=0,'cap applies across all jobs before five-minute filtering');
END;
$$;
DO $$
BEGIN
  UPDATE private.worker_controls SET scheduler_level='normal',scheduler_checked_at=NULL,
    scheduler_healthy_since=NULL,scheduler_last_dispatch_at=NULL WHERE id;
  EXECUTE replace(replace(pg_get_functiondef('private.scheduler_health()'::regprocedure),
    'WITH recent AS MATERIALIZED (','WITH delay AS MATERIALIZED (SELECT pg_sleep(2)), recent AS MATERIALIZED ('),
    'FROM runs,timeouts,backends;','FROM runs,timeouts,backends,delay;');
END;
$$;
SET LOCAL statement_timeout='100ms';
SELECT public.dispatch_work();
SET LOCAL statement_timeout='60s';
SELECT pg_temp.check_rules((SELECT scheduler_level='shed' AND scheduler_health->>'error_code'='57014'
  FROM private.worker_controls),'a real statement timeout persists shed state');
SET LOCAL ROLE service_role;
SELECT public.get_scheduler_health();
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
