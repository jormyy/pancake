BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:60421';
SET LOCAL app.edge_internal_token='retention-local-recipe';
ALTER TABLE public.notification_outbox DISABLE TRIGGER notif_draft_immediate_wake;
\ir rules-support.sql

CREATE TEMP TABLE retention_counts(relation_name text PRIMARY KEY,before_count bigint,first_count bigint,second_count bigint);
CREATE TEMP TABLE retention_verified_receipts(receipt jsonb);

DO $$
DECLARE
  f record; v_player uuid:=gen_random_uuid(); v_old_match uuid:=gen_random_uuid(); v_live_match uuid:=gen_random_uuid();
  v_run uuid:=gen_random_uuid(); v_live_run uuid:=gen_random_uuid(); v_old_session uuid:=gen_random_uuid(); v_live_session uuid:=gen_random_uuid();
  v_now timestamptz:=now(); v_monday date:=date_trunc('week',timezone('America/Los_Angeles',now()))::date;
  v_key uuid:=gen_random_uuid(); v_response bigint; v_reconciled bigint; v_unreconciled bigint;
  v_first jsonb; v_second jsonb; v_idle jsonb; v_started timestamptz; v_dashboard jsonb; v_entry record; v_count bigint; v_before bigint;
  v_old_tipoff timestamptz:=now()-interval '40 days'; v_live_tipoff timestamptz:=now()-interval '1 day';
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9955);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions)
    VALUES(v_player,'Retention','Fixture','PG',ARRAY['PG']);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9955,1,v_monday-35,v_monday-29),(9955,2,v_monday,v_monday+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(v_old_match,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]),
      (v_live_match,f.league_id,f.season_id,2,f.member_ids[1],f.member_ids[2]);
  INSERT INTO private.matchup_forecast_queue(matchup_id,changed_at) VALUES(v_old_match,v_now-interval '40 days')
    ON CONFLICT(matchup_id) DO UPDATE SET changed_at=EXCLUDED.changed_at;
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,valid_until)
    VALUES(v_old_match,f.league_id,1,'{}',v_now-interval '30 days'),(v_live_match,f.league_id,1,'{}',v_now+interval '1 day');

  INSERT INTO public.sync_runs(id,function_name,started_at,finished_at,status,error)
  SELECT md5('retention-daily-sync-'||label)::uuid,'retention-daily',v_now-age,
    CASE WHEN label='unfinished' THEN NULL ELSE v_now-age END,status,error
  FROM (VALUES('old-success',interval '8 days','success',NULL::text),('boundary-success',interval '7 days','success',NULL),
    ('new-success',interval '1 day','success',NULL),('old-failure',interval '31 days','failed','failed'),
    ('boundary-failure',interval '30 days','failed','failed'),('new-failure',interval '1 day','failed','failed'),
    ('unfinished',interval '90 days','running',NULL)) cases(label,age,status,error);
  INSERT INTO public.sync_runs(id,function_name,started_at,finished_at,status)
    VALUES(md5('retention-daily-latest')::uuid,'retention-daily-latest',v_now-interval '120 days',v_now-interval '120 days','success');
  INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,worker_status,worker_finished_at,invocation_key)
  SELECT 'retention-daily',v_now-age,CASE WHEN label='unfinished' THEN NULL ELSE v_now-age END,
    code,status,CASE WHEN label='unfinished' THEN NULL ELSE v_now-age END,md5('retention-daily-inv-'||label)::uuid
  FROM (VALUES('old-success',interval '8 days',200,'success'),('boundary-success',interval '7 days',200,'success'),
    ('new-success',interval '1 day',200,'success'),('old-failure',interval '31 days',500,'failed'),
    ('boundary-failure',interval '30 days',500,'failed'),('new-failure',interval '1 day',500,'failed'),
    ('unfinished',interval '90 days',NULL::int,'running')) cases(label,age,code,status);
  INSERT INTO retention_verified_receipts SELECT jsonb_build_object('verified',true,'invocation',to_jsonb(i),'run',to_jsonb(r))
    FROM public.edge_invocations i CROSS JOIN public.sync_runs r
    WHERE i.invocation_key=md5('retention-daily-inv-old-success')::uuid AND r.id=md5('retention-daily-sync-old-success')::uuid;
  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload,completed,created_at)
    VALUES(f.user_ids[1],v_key,f.member_ids[1],'{}',true,v_now-interval '120 days');

  SELECT COALESCE(max(id),0)+1000000 INTO v_response FROM net._http_response;
  INSERT INTO net._http_response(id,status_code,content,created)
    VALUES(v_response,200,'{}',v_now-interval '7 hours'),(v_response+1,200,'{}',v_now-interval '7 hours'),
      (v_response+2,200,'{}',v_now-interval '6 hours');
  INSERT INTO public.edge_invocations(function_name,request_id,queued_at,reconciled_at,status_code)
    VALUES('retention-response',v_response,v_now-interval '7 hours',v_now-interval '7 hours',200) RETURNING id INTO v_reconciled;
  INSERT INTO public.edge_invocations(function_name,request_id,queued_at)
    VALUES('retention-response',v_response+1,v_now-interval '7 hours') RETURNING id INTO v_unreconciled;

  INSERT INTO cron.job_run_details(jobid,runid,command,status,start_time,end_time)
  SELECT 98609,9860900000+ordinal,'SELECT 1',status,v_now-age,v_now-age
  FROM (VALUES(1,'succeeded',interval '25 hours'),(2,'succeeded',interval '24 hours'),
    (3,'failed',interval '25 hours'),(4,'failed',interval '24 hours'),(5,'running',interval '90 days')) cases(ordinal,status,age);
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category,delivered_at)
    SELECT 'retention-daily-'||ordinal,f.member_ids[1],'lineup_empty','Retention','Retention','lineup',v_now-interval '61 days'
    FROM generate_series(1,5003) ordinal;
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category,delivered_at)
    VALUES('retention-daily-boundary',f.member_ids[1],'lineup_empty','Retention','Retention','lineup',v_now-interval '60 days'),
      ('retention-daily-pending',f.member_ids[1],'lineup_empty','Retention','Retention','lineup',NULL);

  INSERT INTO public.projection_sync_runs(id,projection_type,source_url,projection_date,started_at,status)
    VALUES(v_run,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',v_monday-30,v_now-interval '30 days','success'),
      (v_live_run,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',v_monday,v_now,'success');
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,fetched_at,source_player_name,normalized_player_name,match_status)
    SELECT v_run,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',ordinal,v_now,'Fixture','fixture','unmatched'
    FROM generate_series(1,5003) ordinal;
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,fetched_at,source_player_name,normalized_player_name,match_status)
    VALUES(v_live_run,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',1,v_now,'Fixture','fixture','unmatched');
  INSERT INTO public.sleeper_projection_rows(player_id,source_game_id,sleeper_id,season_year,week_number,game_date,team,opponent,
    points,rebounds,assists,steals,blocks,three_pointers_made,turnovers,field_goals_made,field_goals_attempted,free_throws_made,
    free_throws_attempted,three_pointers_attempted,minutes,last_modified)
    SELECT v_player,'retention-'||ordinal,'retention-fixture',9955,1,game_date,'BOS','LAL',
      1,1,1,1,1,1,1,1,1,1,1,1,1,1 FROM (VALUES(1,v_monday-1),(2,v_monday),(3,v_monday+7)) dates(ordinal,game_date);
  INSERT INTO public.sync_jobs(id,job_type,status,completed_at)
    VALUES(md5('retention-job-old')::uuid,'retention-fixture','completed',v_now-interval '31 days'),
      (md5('retention-job-boundary')::uuid,'retention-fixture','completed',v_now-interval '30 days'),
      (md5('retention-job-pending')::uuid,'retention-pending','pending',NULL);
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,finished_at)
    VALUES(v_old_tipoff,v_old_tipoff::date,'succeeded',v_old_tipoff),(v_live_tipoff,v_live_tipoff::date,'succeeded',v_live_tipoff);
  INSERT INTO public.lineup_tipoff_members(tipoff_at,league_id,league_season_id,member_id)
    VALUES(v_old_tipoff,f.league_id,f.season_id,f.member_ids[1]),(v_live_tipoff,f.league_id,f.season_id,f.member_ids[1]);
  INSERT INTO public.trade_estimate_quotes(id,league_id,league_season_id,member_id,terms,inputs,analysis,model_version,input_version,expires_at)
    VALUES(md5('retention-quote-old')::uuid,f.league_id,f.season_id,f.member_ids[1],'[]','{}','{}','fixture','fixture',v_now-interval '8 days'),
      (md5('retention-quote-boundary')::uuid,f.league_id,f.season_id,f.member_ids[1],'[]','{}','{}','fixture','fixture',v_now-interval '7 days');
  INSERT INTO public.league_change_hints(league_id,topic,revision) VALUES(gen_random_uuid(),'lineup',1);
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
    VALUES(v_old_session,f.user_ids[1],v_now-interval '91 days',v_now-interval '91 days'),
      (v_live_session,f.user_ids[1],v_now-interval '91 days',v_now);
  INSERT INTO auth.refresh_tokens(session_id,user_id,revoked,created_at,updated_at)
    VALUES(v_old_session,f.user_ids[1]::text,false,v_now-interval '91 days',v_now-interval '91 days'),
      (v_live_session,f.user_ids[1]::text,false,v_now,v_now);

  FOR v_entry IN SELECT relation_name FROM private.retention_rules WHERE worker IS NOT NULL
    OR relation_name='public.fantasypros_projection_rows' LOOP
    EXECUTE format('SELECT count(*) FROM %s',v_entry.relation_name::regclass) INTO v_count;
    INSERT INTO retention_counts(relation_name,before_count) VALUES(v_entry.relation_name,v_count);
  END LOOP;
  v_first:=private.run_retention(v_now);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_each(v_first) WHERE jsonb_typeof(value)='object'),'every retention worker completes');
  FOR v_entry IN SELECT * FROM retention_counts LOOP
    EXECUTE format('SELECT count(*) FROM %s',v_entry.relation_name::regclass) INTO v_count;
    UPDATE retention_counts SET first_count=v_count WHERE relation_name=v_entry.relation_name;
    PERFORM pg_temp.check_rules((v_first->>v_entry.relation_name)::bigint=v_entry.before_count-v_count,
      v_entry.relation_name||' first prune reports exact deletions');
  END LOOP;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.projection_sync_runs WHERE id=v_run)
    AND (SELECT count(*)=3 FROM public.fantasypros_projection_rows WHERE run_id=v_run),'projection children obey 5000-row budget before parent deletion');
  PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM public.notification_outbox WHERE dedupe_key LIKE 'retention-daily-%'
    AND delivered_at<v_now-interval '60 days'),'notification prune obeys 5000-row budget');
  PERFORM pg_temp.check_rules((SELECT count(*)=5 FROM public.sync_runs WHERE function_name='retention-daily'),
    'success and failure cutoffs preserve exact boundary and unfinished rows');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.sync_runs WHERE id=md5('retention-daily-latest')::uuid),
    'newest finished source outcome survives any age');
  PERFORM pg_temp.check_rules((SELECT status='failed' AND finished_at=v_now FROM public.sync_runs WHERE id=md5('retention-daily-sync-unfinished')::uuid)
    AND (SELECT worker_status='failed' AND reconciled_at=v_now FROM public.edge_invocations WHERE invocation_key=md5('retention-daily-inv-unfinished')::uuid),
    'abandoned logs become terminal after 30 days instead of growing forever');
  PERFORM pg_temp.check_rules((SELECT count(*)=5 FROM public.edge_invocations WHERE function_name='retention-daily'),
    'invocation cutoffs preserve exact boundary and unfinished rows');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM net._http_response WHERE id=v_response)
    AND (SELECT count(*)=2 FROM net._http_response WHERE id IN(v_response+1,v_response+2)),
    'response expiry preserves unreconciled and exact cutoff rows');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM cron.job_run_details WHERE runid BETWEEN 9860900001 AND 9860900005),
    'cron cutoffs preserve boundaries and expire abandoned execution records');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.sleeper_projection_rows WHERE player_id=v_player),
    'projection week cutoff preserves current and future dates');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.lineup_tipoff_dispatches WHERE tipoff_at=v_old_tipoff)
    AND EXISTS(SELECT 1 FROM public.lineup_tipoff_members WHERE tipoff_at=v_live_tipoff),'tipoff members expire before terminal dispatch');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE matchup_id=v_old_match)
    AND EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE matchup_id=v_live_match)
    AND NOT EXISTS(SELECT 1 FROM public.matchup_forecasts WHERE matchup_id=v_old_match),'old forecast cache and stale retries expire together');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM auth.sessions WHERE id=v_old_session)
    AND EXISTS(SELECT 1 FROM auth.refresh_tokens WHERE session_id=v_live_session),'inactive auth children expire before session; active tokens stay');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.sync_jobs WHERE job_type LIKE 'retention-%'),
    'completed job cutoff preserves pending and exact boundary rows');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.trade_estimate_quotes WHERE id=md5('retention-quote-old')::uuid)
    AND EXISTS(SELECT 1 FROM public.trade_estimate_quotes WHERE id=md5('retention-quote-boundary')::uuid),'quote expiry preserves exact boundary');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.league_change_hints h WHERE NOT EXISTS(SELECT 1 FROM public.leagues l WHERE l.id=h.league_id)),
    'only orphan change hints expire');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.trade_offer_requests WHERE request_id=v_key AND completed),
    'verified idempotency receipt survives normal log retention');
  PERFORM pg_temp.check_rules((SELECT receipt->>'verified'='true' AND receipt->'invocation'->>'invocation_key'=md5('retention-daily-inv-old-success')::uuid::text
    AND receipt->'run'->>'id'=md5('retention-daily-sync-old-success')::uuid::text FROM retention_verified_receipts),
    'verified replay receipt summary survives expiry of its raw invocation and run');

  v_second:=private.run_retention(v_now);
  FOR v_entry IN SELECT * FROM retention_counts LOOP
    EXECUTE format('SELECT count(*) FROM %s',v_entry.relation_name::regclass) INTO v_count;
    PERFORM pg_temp.check_rules((v_second->>v_entry.relation_name)::bigint=v_entry.first_count-v_count
      AND (SELECT rows_pruned=v_entry.before_count-v_count FROM private.retention_status WHERE relation_name=v_entry.relation_name),
      v_entry.relation_name||' cumulative summary matches both bounded prunes');
  END LOOP;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.projection_sync_runs WHERE id=v_run)
    AND EXISTS(SELECT 1 FROM public.fantasypros_projection_rows WHERE run_id=v_live_run),'next batch removes exhausted run and keeps current projection rows');
  v_started:=clock_timestamp();
  v_idle:=private.run_retention(v_now);
  PERFORM pg_temp.check_rules(clock_timestamp()-v_started<interval '1 second'
    AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(v_idle) WHERE value::bigint<>0),'drained daily retention is an idle no-op under one second');
  v_dashboard:=public.retention_dashboard();
  PERFORM pg_temp.check_rules((SELECT bool_and((entry->>'total_bytes')::bigint>=0 AND entry->>'retention_rule' IS NOT NULL)
    FROM jsonb_array_elements(v_dashboard->'tables') entry),'dashboard reports every relation size and rule');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.retention_status)=(SELECT count(*) FROM retention_counts),
    'retention summary has one row per pruned table');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.retention_dashboard()','EXECUTE')
    AND NOT has_function_privilege('anon','private.run_retention(timestamptz)','EXECUTE'),'retention and dashboard require backend access');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(jobname='work-dispatcher' AND schedule='* * * * *' AND command LIKE '%public.dispatch_work()%') FROM cron.job WHERE jobname NOT IN ('io-hint-drain','io-cron-history-retention')),'one dispatcher cron entry owns daily retention scheduling');
END;
$$;
SELECT count(*) AS passed FROM rules_checks;
ROLLBACK;
