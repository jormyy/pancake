BEGIN;

SELECT cron.schedule('work-dispatcher','* * * * *','SELECT public.dispatch_work();')
WHERE NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='work-dispatcher');

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000098001', 'authenticated', 'authenticated',
  'retention-pruning@example.test', 'x', now(), '{}'::jsonb,
  '{"username":"retention_pruning"}'::jsonb, now(), now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.leagues (id, name, slug, invite_code, commissioner_id, status)
VALUES (
  '00000000-0000-0000-0000-000000098101', 'Retention Pruning League',
  'retention-pruning-league', 'RETENTIONPRUNE00',
  '00000000-0000-0000-0000-000000098001', 'active'
);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES (
  '00000000-0000-0000-0000-000000098201',
  '00000000-0000-0000-0000-000000098101',
  '00000000-0000-0000-0000-000000098001', 'commissioner', 'Retention Team'
);

-- Four seasons: 3904 current, 3903 previous, 3902 and 3901 old.
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
SELECT
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098101',
  year_value,
  year_value = 3904
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.players (id, first_name, last_name, position, eligible_positions)
VALUES ('00000000-0000-0000-0000-000000098301', 'Retention', 'Fixture', 'PG', ARRAY['PG']);

INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
SELECT year_value, 1, date '2101-01-01', date '2101-01-07'
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, week_number, slot_type, game_date)
SELECT
  '00000000-0000-0000-0000-000000098101',
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098201',
  '00000000-0000-0000-0000-000000098301',
  1, 'PG', date '2101-01-01'
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.standings (league_id, league_season_id, member_id, week_number, waiver_priority)
SELECT
  '00000000-0000-0000-0000-000000098101',
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098201',
  week_value, 1
FROM generate_series(3901, 3904) AS year_value
CROSS JOIN generate_series(1, 3) AS week_value;

INSERT INTO public.roster_transactions (league_id, league_season_id, member_id, player_id, transaction_type)
SELECT
  '00000000-0000-0000-0000-000000098101',
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098201',
  '00000000-0000-0000-0000-000000098301',
  'carry_over'
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.sync_runs (id, function_name, started_at, status)
VALUES
  ('00000000-0000-0000-0000-000000098401', 'retention-old', now() - interval '120 days', 'success'),
  ('00000000-0000-0000-0000-000000098402', 'retention-new', now() - interval '1 day', 'success');

INSERT INTO public.projection_sync_runs (id, source, projection_type, source_url, started_at, status, projection_date)
VALUES
  ('00000000-0000-0000-0000-000000098501', 'fantasypros', 'daily',
   'https://www.fantasypros.com/nba/projections/daily-overall.php', now() - interval '60 days', 'success', current_date - 50),
  ('00000000-0000-0000-0000-000000098502', 'fantasypros', 'daily',
   'https://www.fantasypros.com/nba/projections/daily-overall.php', now() - interval '1 day', 'success', current_date + 7);

INSERT INTO public.fantasypros_projection_rows (
  run_id, projection_type, source_url, source_row_number, fetched_at,
  source_player_name, normalized_player_name, match_status
)
SELECT run_id, 'daily', 'https://www.fantasypros.com/nba/projections/daily-overall.php',
       1, now(), 'Retention Fixture', 'retention fixture', 'unmatched'
FROM unnest(ARRAY[
  '00000000-0000-0000-0000-000000098501',
  '00000000-0000-0000-0000-000000098502'
]::uuid[]) AS run_id;

CREATE TEMP TABLE history_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_history(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO history_checks VALUES(label);
END;
$$;

INSERT INTO public.sync_runs(id,function_name,started_at,finished_at,status,error) VALUES
  (md5('history-ops-old')::uuid,'test-retention-live-poll',now()-interval '8 days',now()-interval '8 days','success',NULL),
  (md5('history-ops-boundary')::uuid,'test-retention-live-poll',now()-interval '7 days',now()-interval '7 days','success',NULL),
  (md5('history-ops-recent')::uuid,'test-retention-live-poll',now()-interval '1 day',now()-interval '1 day','success',NULL),
  (md5('history-ops-failure')::uuid,'test-retention-live-poll',now()-interval '120 days',now()-interval '120 days','failed','Provider failed'),
  (md5('history-daily-old')::uuid,'test-retention-season-boundary',now()-interval '120 days',now()-interval '120 days','success',NULL),
  (md5('history-ops-error')::uuid,'test-retention-live-poll',now()-interval '120 days',now()-interval '120 days','success','Partial failure'),
  (md5('history-ops-unfinished')::uuid,'test-retention-live-poll',now()-interval '120 days',NULL,'running',NULL);

INSERT INTO public.edge_invocations(id,function_name,request_id,queued_at,status_code,error_message,reconciled_at)
OVERRIDING SYSTEM VALUE VALUES
  (986080001,'test-retention-live-poll',NULL,now()-interval '8 days',200,NULL,now()-interval '8 days'),
  (986080002,'test-retention-live-poll',NULL,now()-interval '7 days',200,NULL,now()-interval '7 days'),
  (986080003,'test-retention-live-poll',NULL,now()-interval '120 days',500,'Worker failed',now()-interval '120 days'),
  (986080004,'test-retention-live-poll',NULL,now()-interval '120 days',200,'Partial failure',now()-interval '120 days'),
  (986080005,'test-retention-season-boundary',NULL,now()-interval '120 days',200,NULL,now()-interval '120 days'),
  (986080006,'test-retention-unknown-important',NULL,now()-interval '120 days',200,NULL,now()-interval '120 days');

INSERT INTO public.edge_invocations (id,function_name,queued_at,status_code,reconciled_at,worker_status,worker_started_at,worker_finished_at)
OVERRIDING SYSTEM VALUE VALUES
  (986080007,'test-retention-live-poll',now()-interval '120 days',200,now()-interval '120 days','failed',now()-interval '120 days',now()-interval '120 days'),
  (986080008,'test-retention-live-poll',now()-interval '120 days',200,now()-interval '120 days','running',now()-interval '120 days',NULL);

INSERT INTO cron.job_run_details(jobid,runid,command,status,return_message,start_time,end_time) VALUES
  (98601,9860100001,'SELECT 1','succeeded','unknown old job',now()-interval '120 days',now()-interval '120 days'),
  (98602,9860100002,'SELECT public.invoke_edge_function(''sync-stats'');','succeeded','obsolete high frequency',now()-interval '8 days',now()-interval '8 days'),
  (98602,9860100003,'SELECT public.invoke_edge_function(''sync-stats'');','failed','old failure',now()-interval '120 days',now()-interval '120 days'),
  (98602,9860100004,'SELECT public.invoke_edge_function(''sync-stats'');','succeeded','exact boundary',now()-interval '7 days',now()-interval '7 days'),
  (98602,9860100007,'SELECT public.invoke_edge_function(''sync-stats'',''{}''::jsonb);','succeeded','obsolete with body',now()-interval '8 days',now()-interval '8 days'),
  (98603,9860100005,'SELECT public.invoke_edge_function(''sync-players'');','succeeded','important daily',now()-interval '120 days',now()-interval '120 days');
INSERT INTO cron.job_run_details(jobid,runid,command,status,return_message,start_time,end_time)
SELECT jobid,9860100006,'SELECT public.dispatch_work();','succeeded','current high frequency',now()-interval '8 days',now()-interval '8 days'
FROM cron.job WHERE jobname='work-dispatcher';
SELECT pg_temp.check_history(EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid=9860100006),'active high frequency job fixture exists');

INSERT INTO public.sync_runs(id,function_name,started_at,finished_at,status,error)
SELECT md5('generic-retention-'||function_name||'-'||kind)::uuid,function_name,now()-age,now()-age,status,error
FROM unnest(ARRAY['test-retention-nba-lineup-optimizer','test-retention-weekly-source','test-retention-june-july-source','test-retention-unknown-new-source']) function_name
CROSS JOIN (VALUES ('older-success',interval '121 days','success',NULL::text),
  ('latest-success',interval '120 days','success',NULL::text),
  ('older-failure',interval '61 days','failed','failed'),('latest-failure',interval '60 days','failed','failed')) cases(kind,age,status,error);
INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,error_message)
SELECT function_name,now()-age,now()-age,status_code,error
FROM unnest(ARRAY['test-retention-nba-lineup-optimizer','test-retention-weekly-source','test-retention-june-july-source','test-retention-unknown-new-source']) function_name
CROSS JOIN (VALUES (interval '121 days',200,NULL::text),(interval '120 days',200,NULL::text),
  (interval '61 days',500,'failed'),(interval '60 days',500,'failed')) cases(age,status_code,error);
INSERT INTO public.edge_invocations(id,function_name,queued_at,status_code,reconciled_at,worker_started_at,worker_finished_at,worker_status)
OVERRIDING SYSTEM VALUE VALUES
  (986080009,'test-retention-unknown-new-source',now()-interval '121 days',200,NULL,NULL,NULL,NULL),
  (986080010,'test-retention-unknown-new-source',now()-interval '121 days',200,now()-interval '121 days',now()-interval '121 days',NULL,'running');
INSERT INTO public.edge_invocations(id,function_name,queued_at,status_code,reconciled_at,worker_started_at,worker_status)
OVERRIDING SYSTEM VALUE VALUES
  (986080011,'test-retention-crashed-worker',now()-interval '61 days',200,now()-interval '61 days',now()-interval '61 days','failed'),
  (986080012,'test-retention-crashed-worker',now()-interval '60 days',200,now()-interval '60 days',now()-interval '60 days','failed'),
  (986080013,'test-retention-crashed-worker-boundary',now()-interval '31 days',200,now()-interval '31 days',now()-interval '31 days','failed'),
  (986080014,'test-retention-crashed-worker-boundary',now()-interval '30 days',200,now()-interval '30 days',now()-interval '30 days','failed'),
  (986080015,'test-retention-crashed-worker-boundary',now()-interval '29 days',200,now()-interval '29 days',now()-interval '29 days','failed'),
  (986080016,'test-retention-crashed-worker',now()-interval '120 days',200,NULL,now()-interval '120 days','failed');
CREATE TEMP TABLE retention_before AS SELECT
  (SELECT count(*) FROM public.sync_runs) AS sync_runs,
  (SELECT count(*) FROM public.edge_invocations) AS edge_invocations,
  (SELECT count(*) FROM cron.job_run_details) AS cron_job_run_details,
  (SELECT count(*) FROM public.projection_sync_runs) AS projection_sync_runs,
  (SELECT count(*) FROM public.fantasypros_projection_rows) AS fantasypros_projection_rows;

CREATE FUNCTION pg_temp.reject_cleanup_history_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cleanup attempts a protected history write on %.%',TG_TABLE_SCHEMA,TG_TABLE_NAME;
END;
$$;
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT namespace.nspname AS schema_name,relation.relname AS table_name
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE relation.relkind IN ('r','p') AND (
      namespace.nspname='public' AND relation.relname NOT IN ('sync_runs','edge_invocations','projection_sync_runs','fantasypros_projection_rows','sleeper_projection_rows','notification_outbox')
      OR namespace.nspname='private' AND relation.relname='retired_score_inputs'
    )
  LOOP
    EXECUTE format('CREATE TRIGGER history_cleanup_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.reject_cleanup_history_write()',target.schema_name,target.table_name);
  END LOOP;
END;
$$;

SELECT public.prune_unbounded_history() AS prune_result \gset


SELECT pg_temp.check_history((SELECT count(*)=4 FROM public.weekly_lineups WHERE league_id='00000000-0000-0000-0000-000000098101'),'all season lineups survive');
SELECT pg_temp.check_history((SELECT count(*)=12 FROM public.standings WHERE league_id='00000000-0000-0000-0000-000000098101'),'all intermediate and final standings survive');
SELECT pg_temp.check_history((SELECT count(*)=4 FROM public.roster_transactions WHERE league_id='00000000-0000-0000-0000-000000098101'),'all season transactions survive');
SELECT pg_temp.check_history((SELECT count(*)=1 FROM public.projection_sync_runs WHERE id IN('00000000-0000-0000-0000-000000098501','00000000-0000-0000-0000-000000098502')),'only the current projection period survives');
SELECT pg_temp.check_history((SELECT count(*)=1 FROM public.fantasypros_projection_rows WHERE run_id IN('00000000-0000-0000-0000-000000098501','00000000-0000-0000-0000-000000098502')),'old projection rows expire');
SELECT pg_temp.check_history((SELECT count(*)=2 FROM public.sync_runs WHERE function_name LIKE 'retention-%'),'unclassified operations survive');
SELECT pg_temp.check_history(NOT EXISTS(SELECT 1 FROM public.sync_runs WHERE id=md5('history-ops-old')::uuid),'old completed high frequency run pruned');
SELECT pg_temp.check_history((SELECT count(*)=5 FROM public.sync_runs WHERE id IN(SELECT md5(value)::uuid FROM unnest(ARRAY['history-ops-boundary','history-ops-recent','history-ops-failure','history-daily-old','history-ops-error','history-ops-unfinished']) value)),'newest success and failure, boundary, and unfinished work survive');
SELECT pg_temp.check_history(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE id=986080001),'old successful high frequency invocation pruned');
SELECT pg_temp.check_history((SELECT count(*)=3 FROM public.edge_invocations WHERE id BETWEEN 986080002 AND 986080006),'invocation boundary failures and important jobs survive cleanup and reconciliation');
SELECT pg_temp.check_history((SELECT count(*)=2 FROM public.edge_invocations WHERE id IN(986080007,986080008)),'worker failures and unfinished outcomes survive even with HTTP 200');
SELECT pg_temp.check_history(NOT EXISTS(SELECT 1 FROM cron.job_run_details WHERE runid IN(9860100002,9860100006,9860100007)),'obsolete and current successful high frequency cron rows pruned');
SELECT pg_temp.check_history((SELECT count(*)=1 FROM cron.job_run_details WHERE runid IN(9860100001,9860100003,9860100004,9860100005)),'only cron cutoff boundary survives across all job names');
SELECT pg_temp.check_history((SELECT count(*)=8 FROM public.sync_runs WHERE function_name IN('test-retention-nba-lineup-optimizer','test-retention-weekly-source','test-retention-june-july-source','test-retention-unknown-new-source')),
  'every function retains its newest success and failure even when both are old');
SELECT pg_temp.check_history((SELECT count(*)=10 FROM public.edge_invocations WHERE function_name IN('test-retention-nba-lineup-optimizer','test-retention-weekly-source','test-retention-june-july-source','test-retention-unknown-new-source')),
  'every invocation source retains newest outcomes and pending reconciliation work');
SELECT pg_temp.check_history(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE id IN(986080011,986080013)),
  'reconciled crashed workers expire after thirty days without a finish time');
SELECT pg_temp.check_history((SELECT count(*)=4 FROM public.edge_invocations WHERE id IN(986080012,986080014,986080015,986080016)),
  'newest crashed failure, cutoff boundary, recent failure, and unreconciled crash survive');
SELECT pg_temp.check_history((SELECT bool_and((:'prune_result'::jsonb->>entry.key)::bigint=entry.before_count-entry.after_count)
  FROM retention_before b CROSS JOIN LATERAL (VALUES
    ('sync_runs',b.sync_runs,(SELECT count(*) FROM public.sync_runs)),
    ('edge_invocations',b.edge_invocations,(SELECT count(*) FROM public.edge_invocations)),
    ('cron_job_run_details',b.cron_job_run_details,(SELECT count(*) FROM cron.job_run_details)),
    ('projection_sync_runs',b.projection_sync_runs,(SELECT count(*) FROM public.projection_sync_runs)),
    ('fantasypros_projection_rows',b.fantasypros_projection_rows,(SELECT count(*) FROM public.fantasypros_projection_rows))
  ) entry(key,before_count,after_count)), 'all returned table counts equal observed deletions');
DO $$
DECLARE caller text; denied boolean;
BEGIN
  FOREACH caller IN ARRAY ARRAY['anon','authenticated'] LOOP
    denied:=false;
    EXECUTE format('SET LOCAL ROLE %I',caller);
    BEGIN
      PERFORM public.prune_unbounded_history();
    EXCEPTION WHEN insufficient_privilege THEN denied:=true;
    END;
    RESET ROLE;
    PERFORM pg_temp.check_history(denied,caller||' cannot execute cleanup');
  END LOOP;
END;
$$;
SET LOCAL ROLE service_role;
SELECT public.prune_unbounded_history();
RESET ROLE;
SELECT count(*) AS passed FROM history_checks;
ROLLBACK;
