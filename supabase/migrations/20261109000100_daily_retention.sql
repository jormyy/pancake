SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE private.retention_rules (
  relation_name text PRIMARY KEY,
  retention_rule text NOT NULL,
  worker text CHECK(worker IS NULL OR worker ~ '^retain_[a-z_]+$'),
  run_order integer NOT NULL DEFAULT 100
);
CREATE TABLE private.retention_status (
  relation_name text PRIMARY KEY REFERENCES private.retention_rules(relation_name),
  last_checked_at timestamptz,
  last_pruned_at timestamptz,
  rows_pruned bigint NOT NULL DEFAULT 0 CHECK(rows_pruned>=0),
  last_rows_pruned bigint NOT NULL DEFAULT 0 CHECK(last_rows_pruned>=0),
  last_error text
);
REVOKE ALL ON private.retention_rules,private.retention_status FROM PUBLIC,anon,authenticated;
GRANT SELECT ON private.retention_rules,private.retention_status TO service_role;

INSERT INTO private.retention_rules(relation_name,retention_rule)
SELECT n.nspname||'.'||c.relname,
  CASE n.nspname WHEN 'auth' THEN 'Managed Auth lifecycle; session expiry and token rotation belong to Auth'
    WHEN 'storage' THEN 'Managed Storage metadata; remove files through the Storage API'
    ELSE 'Durable product history or current keyed state; retained with its owning entity' END
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p','m') AND n.nspname IN ('public','private','analytics','auth','storage','cron','net');

INSERT INTO private.retention_rules(relation_name,retention_rule,worker,run_order) VALUES
  ('public.sync_runs','Finished success: 7 days; failure: 30 days; keep newest outcome per function and unfinished work; close abandoned work after 30 days','retain_sync_runs',20),
  ('public.edge_invocations','Reconciled success: 7 days; failure: 30 days; keep newest outcome per function and unfinished work; close abandoned work after 30 days','retain_edge_invocations',10),
  ('cron.job_run_details','Succeeded: 7 days; failed: 30 days; active executions stay; orphan executions expire after 30 days','retain_cron_job_run_details',30),
  ('net._http_response','6 hours; keep unreconciled invocation responses','retain_pg_net_responses',40),
  ('public.notification_outbox','Terminal delivery, suppression or dead letter: 60 days; pending work stays','retain_notification_outbox',50),
  ('public.sleeper_projection_rows','Current Pacific scoring week and future dates; expire older dates','retain_sleeper_projection_rows',60),
  ('public.projection_sync_runs','Current Pacific scoring period and future periods; bounded child deletion first','retain_projection_sync_runs',70),
  ('public.fantasypros_projection_rows','Same scoring period as parent run; 10000 rows per call; no unbounded cascade',NULL,71),
  ('public.sync_jobs','Completed: 30 days; failed and pending checkpoints stay for resume','retain_sync_jobs',80),
  ('public.lineup_tipoff_members','Terminal dispatch: 30 days; at most 5000 member receipts per call','retain_lineup_tipoff_members',90),
  ('public.lineup_tipoff_dispatches','Terminal: 30 days; delete only after all member receipts expire','retain_lineup_tipoff_dispatches',91),
  ('public.matchup_forecasts','Expired cache: 7 days after validity and matchup end; no historical forecast archive','retain_matchup_forecasts',100),
  ('private.matchup_forecast_queue','7 days after matchup end; void matches expire; active claims stay','retain_matchup_forecast_queue',110),
  ('public.trade_estimate_quotes','Unlinked quotes: 7 days after expiry; frozen trade evidence stays','retain_trade_estimate_quotes',120),
  ('public.league_change_hints','One revision per league and topic; remove orphan rows; never reset live revision','retain_league_change_hints',130),
  ('private.retention_status','One cumulative summary per table; no per-run history',NULL,140),
  ('private.retention_rules','One rule per table; no per-run history',NULL,140)
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule,worker=EXCLUDED.worker,run_order=EXCLUDED.run_order;

INSERT INTO private.retention_rules(relation_name,retention_rule,worker,run_order) VALUES
  ('auth.refresh_tokens','Expired or 90-day inactive sessions; revoked tokens: 7 days; bounded child deletion first','retain_auth_refresh_tokens',150),
  ('auth.sessions','Expired: 7 days; inactive: 90 days; remove only after refresh tokens expire','retain_auth_sessions',151),
  ('private.provider_history_policy','One coverage policy per provider; no per-season history',NULL,160),
  ('private.trade_offer_requests','Idempotency receipts stay with trade history; normal log pruning never deletes them',NULL,160)
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule,worker=EXCLUDED.worker,run_order=EXCLUDED.run_order;

CREATE INDEX lineup_tipoff_terminal_retention ON public.lineup_tipoff_dispatches(finished_at,tipoff_at) WHERE status IN ('succeeded','failed');
CREATE INDEX sync_runs_finished_retention ON public.sync_runs(finished_at,id) WHERE finished_at IS NOT NULL;
CREATE INDEX sync_jobs_completed_retention ON public.sync_jobs(completed_at,id) WHERE status='completed';
CREATE INDEX trade_estimate_expiry_retention ON public.trade_estimate_quotes(expires_at,id);

CREATE OR REPLACE FUNCTION private.retain_sync_runs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint; v_total bigint:=0; v_outcome integer; v_condition text; v_age interval;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.sync_runs r
    WHERE r.finished_at IS NULL AND r.started_at<p_now-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM public.edge_invocations i WHERE i.sync_run_id=r.id
        AND i.worker_status='running' AND i.worker_started_at>=p_now-interval '30 days')
    ORDER BY r.started_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) UPDATE public.sync_runs r SET status='failed',finished_at=p_now,
    error=COALESCE(r.error,'Worker remains unfinished after 30 days')
  FROM stale WHERE r.id=stale.id;
  FOR v_outcome IN 1..2 LOOP
    IF v_outcome=1 THEN
      v_condition:='status=''success'' AND error IS NULL AND finished_at IS NOT NULL';
      v_age:=interval '7 days';
    ELSE
      v_condition:='(status=''failed'' OR error IS NOT NULL) AND finished_at IS NOT NULL';
      v_age:=interval '30 days';
    END IF;
    EXECUTE format($query$
      WITH victims AS (
        SELECT r.id FROM public.sync_runs r
        WHERE %1$s AND r.finished_at<$1-$2
          AND r.id IS DISTINCT FROM (SELECT newest.id FROM public.sync_runs newest
            WHERE newest.function_name=r.function_name AND %1$s
            ORDER BY newest.started_at DESC,newest.id DESC LIMIT 1)
        ORDER BY r.finished_at,r.id LIMIT 10000 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM public.sync_runs r USING victims v WHERE r.id=v.id
    $query$,v_condition) USING p_now,v_age;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
  END LOOP;
  RETURN jsonb_build_object('public.sync_runs',v_total);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_edge_invocations(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint; v_total bigint:=0; v_outcome integer; v_condition text; v_age interval;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.edge_invocations r
    WHERE (r.reconciled_at IS NULL OR r.worker_status='running')
      AND GREATEST(r.queued_at,r.worker_started_at)<p_now-interval '30 days'
    ORDER BY r.queued_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) UPDATE public.edge_invocations r SET reconciled_at=COALESCE(r.reconciled_at,p_now),
    worker_status='failed',worker_finished_at=COALESCE(r.worker_finished_at,p_now),
    error_message=COALESCE(r.error_message,'Invocation remains unfinished after 30 days')
  FROM stale WHERE r.id=stale.id;
  FOR v_outcome IN 1..2 LOOP
    IF v_outcome=1 THEN
      v_condition:='status_code BETWEEN 200 AND 299 AND error_message IS NULL AND worker_status IS DISTINCT FROM ''failed'' AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL) AND worker_status IS DISTINCT FROM ''running''';
      v_age:=interval '7 days';
    ELSE
      v_condition:='(status_code IS NULL OR status_code NOT BETWEEN 200 AND 299 OR error_message IS NOT NULL OR worker_status=''failed'') AND reconciled_at IS NOT NULL AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL OR worker_status=''failed'') AND worker_status IS DISTINCT FROM ''running''';
      v_age:=interval '30 days';
    END IF;
    EXECUTE format($query$
      WITH victims AS (
        SELECT r.id FROM public.edge_invocations r
        WHERE %1$s AND r.reconciled_at<$1-$2
          AND r.id IS DISTINCT FROM (SELECT newest.id FROM public.edge_invocations newest
            WHERE newest.function_name=r.function_name AND %1$s
            ORDER BY newest.queued_at DESC,newest.id DESC LIMIT 1)
        ORDER BY r.reconciled_at,r.id LIMIT 10000 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM public.edge_invocations r USING victims v WHERE r.id=v.id
    $query$,v_condition) USING p_now,v_age;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
  END LOOP;
  RETURN jsonb_build_object('public.edge_invocations',v_total);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_cron_job_run_details(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.runid FROM cron.job_run_details r
    WHERE (r.status IN ('succeeded','failed') AND COALESCE(r.end_time,r.start_time)<p_now-CASE WHEN r.status='succeeded' THEN interval '7 days' ELSE interval '30 days' END)
      OR (r.status NOT IN ('succeeded','failed') AND r.start_time<p_now-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity active
          WHERE active.pid=r.job_pid AND active.backend_start<=r.start_time))
    ORDER BY r.runid LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM cron.job_run_details r USING victims v WHERE r.runid=v.runid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('cron.job_run_details',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_pg_net_responses(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM net._http_response r
    WHERE r.created<p_now-interval '6 hours'
      AND NOT EXISTS (SELECT 1 FROM public.edge_invocations i WHERE i.request_id=r.id AND i.reconciled_at IS NULL)
    ORDER BY r.created,r.id LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM net._http_response r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('net._http_response',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_notification_outbox(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.notification_outbox r
    WHERE COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at)<p_now-interval '60 days'
    ORDER BY COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at),r.id LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.notification_outbox r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.notification_outbox',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_sleeper_projection_rows(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint; v_previous text:=COALESCE(current_setting('pancake.projection_cleanup',true),'');
BEGIN
  PERFORM set_config('pancake.projection_cleanup','on',true);
  WITH victims AS (
    SELECT r.id FROM public.sleeper_projection_rows r
    WHERE r.game_date<date_trunc('week',timezone('America/Los_Angeles',p_now))::date
    ORDER BY r.game_date,r.id LIMIT 10000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.sleeper_projection_rows r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  PERFORM set_config('pancake.projection_cleanup',v_previous,true);
  RETURN jsonb_build_object('public.sleeper_projection_rows',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_projection_sync_runs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_ids uuid[]; v_counts jsonb;
BEGIN
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.projection_sync_runs
    WHERE projection_period_end<date_trunc('week',timezone('America/Los_Angeles',p_now))::date
    ORDER BY projection_period_end,id LIMIT 200
  ) expired;
  v_counts:=private.delete_projection_runs(v_ids,10000);
  RETURN jsonb_build_object('public.projection_sync_runs',COALESCE((v_counts->>'projection_sync_runs')::bigint,0),
    'public.fantasypros_projection_rows',COALESCE((v_counts->>'fantasypros_projection_rows')::bigint,0));
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_sync_jobs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.sync_jobs r
    WHERE r.status='completed' AND r.completed_at<p_now-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM public.sync_jobs active WHERE active.job_type=r.job_type AND active.status IN ('pending','running')
        AND active.metadata->>'seasonYear'=r.metadata->>'seasonYear')
    ORDER BY r.completed_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.sync_jobs r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.sync_jobs',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_members(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.ctid FROM public.lineup_tipoff_members r
    WHERE r.tipoff_at<p_now-interval '30 days'
      AND EXISTS (SELECT 1 FROM public.lineup_tipoff_dispatches d WHERE d.tipoff_at=r.tipoff_at
        AND d.status IN ('succeeded','failed') AND d.finished_at<p_now-interval '30 days')
    ORDER BY r.tipoff_at,r.league_id,r.league_season_id,r.member_id,r.input_revision LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.lineup_tipoff_members r USING victims v WHERE r.ctid=v.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.lineup_tipoff_members',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_dispatches(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.tipoff_at FROM public.lineup_tipoff_dispatches r
    WHERE r.status IN ('succeeded','failed') AND r.finished_at<p_now-interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM public.lineup_tipoff_members m WHERE m.tipoff_at=r.tipoff_at)
    ORDER BY r.tipoff_at LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.lineup_tipoff_dispatches r USING victims v WHERE r.tipoff_at=v.tipoff_at;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.lineup_tipoff_dispatches',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.matchup_id FROM public.matchup_forecasts r
    WHERE r.valid_until<p_now-interval '7 days' AND EXISTS (SELECT 1 FROM public.matchups m
        JOIN public.league_seasons s ON s.id=m.league_season_id
        JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=COALESCE(m.end_week_number,m.week_number)
        WHERE m.id=r.matchup_id AND (m.is_voided OR w.week_end<(p_now AT TIME ZONE 'America/New_York')::date-7))
    ORDER BY r.valid_until,r.matchup_id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.matchup_forecasts r USING victims v WHERE r.matchup_id=v.matchup_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.matchup_forecasts',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_matchup_forecast_queue(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.matchup_id FROM private.matchup_forecast_queue r
    WHERE (r.claimed_at IS NULL OR r.claimed_at<p_now-interval '3 minutes') AND EXISTS (SELECT 1 FROM public.matchups m
        JOIN public.league_seasons s ON s.id=m.league_season_id
        JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=COALESCE(m.end_week_number,m.week_number)
        WHERE m.id=r.matchup_id AND (m.is_voided OR w.week_end<(p_now AT TIME ZONE 'America/New_York')::date-7))
    ORDER BY r.changed_at,r.matchup_id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.matchup_forecast_queue r USING victims v WHERE r.matchup_id=v.matchup_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.matchup_forecast_queue',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_trade_estimate_quotes(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.trade_estimate_quotes r
    WHERE r.expires_at<p_now-interval '7 days' AND NOT EXISTS (SELECT 1 FROM public.trade_estimates e WHERE e.quote_id=r.id)
    ORDER BY r.expires_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.trade_estimate_quotes r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.trade_estimate_quotes',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_league_change_hints(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.ctid FROM public.league_change_hints r
    WHERE NOT EXISTS (SELECT 1 FROM public.leagues l WHERE l.id=r.league_id)
    ORDER BY r.league_id,r.topic LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.league_change_hints r USING victims v WHERE r.ctid=v.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.league_change_hints',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_auth_refresh_tokens(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint; v_revoked bigint;
BEGIN
  WITH expired_sessions AS MATERIALIZED (
    SELECT s.id FROM auth.sessions s
    WHERE s.not_after<p_now-interval '7 days'
      OR GREATEST(s.updated_at,s.created_at,s.refreshed_at AT TIME ZONE 'UTC')<p_now-interval '90 days'
    ORDER BY s.created_at,s.id LIMIT 500 FOR UPDATE OF s SKIP LOCKED
  ), victims AS (
    SELECT r.id FROM auth.refresh_tokens r JOIN expired_sessions s ON s.id=r.session_id
    ORDER BY r.id LIMIT 10000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM auth.refresh_tokens r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  WITH victims AS (
    SELECT r.id FROM auth.refresh_tokens r
    WHERE r.revoked AND r.updated_at<p_now-interval '7 days'
    ORDER BY r.id LIMIT 10000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM auth.refresh_tokens r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_revoked=ROW_COUNT;
  RETURN jsonb_build_object('auth.refresh_tokens',v_count+v_revoked);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_auth_sessions(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT s.id FROM auth.sessions s
    WHERE (s.not_after<p_now-interval '7 days'
      OR GREATEST(s.updated_at,s.created_at,s.refreshed_at AT TIME ZONE 'UTC')<p_now-interval '90 days')
      AND NOT EXISTS(SELECT 1 FROM auth.refresh_tokens r WHERE r.session_id=s.id)
    ORDER BY s.created_at,s.id LIMIT 500 FOR UPDATE OF s SKIP LOCKED
  ) DELETE FROM auth.sessions s USING victims v WHERE s.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('auth.sessions',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.run_retention(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE
  v_rule record; v_entry record; v_counts jsonb; v_result jsonb:='{}'::jsonb;
  v_started timestamptz:=clock_timestamp(); v_error text;
BEGIN
  IF p_now IS NULL THEN RAISE EXCEPTION 'A retention time is required.' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('private.run_retention',0)) THEN
    RETURN jsonb_build_object('busy',true);
  END IF;
  FOR v_rule IN SELECT rules.* FROM private.retention_rules rules
    LEFT JOIN private.retention_status status USING(relation_name)
    WHERE rules.worker IS NOT NULL
    ORDER BY status.last_checked_at NULLS FIRST,rules.run_order,rules.relation_name
  LOOP
    EXIT WHEN clock_timestamp()-v_started>=interval '5 seconds';
    BEGIN
      EXECUTE format('SELECT private.%I($1)',v_rule.worker) INTO v_counts USING p_now;
      FOR v_entry IN SELECT key,value::bigint AS removed FROM jsonb_each_text(v_counts) LOOP
        INSERT INTO private.retention_status AS state(relation_name,last_checked_at,last_pruned_at,rows_pruned,last_rows_pruned,last_error)
        VALUES(v_entry.key,p_now,CASE WHEN v_entry.removed>0 THEN p_now END,v_entry.removed,v_entry.removed,NULL)
        ON CONFLICT(relation_name) DO UPDATE SET last_checked_at=p_now,
          last_pruned_at=COALESCE(EXCLUDED.last_pruned_at,state.last_pruned_at),
          rows_pruned=state.rows_pruned+EXCLUDED.rows_pruned,last_rows_pruned=EXCLUDED.last_rows_pruned,last_error=NULL;
      END LOOP;
      v_result:=v_result||v_counts;
    EXCEPTION WHEN OTHERS OR query_canceled THEN
      v_error:=left(SQLSTATE||': '||SQLERRM,1000);
      INSERT INTO private.retention_status AS state(relation_name,last_checked_at,last_error)
      VALUES(v_rule.relation_name,p_now,v_error)
      ON CONFLICT(relation_name) DO UPDATE SET last_checked_at=p_now,last_error=EXCLUDED.last_error;
      v_result:=v_result||jsonb_build_object(v_rule.relation_name,jsonb_build_object('error',v_error));
      IF SQLSTATE='57014' THEN RETURN v_result; END IF;
    END;
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.retention_dashboard()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH relations AS (
    SELECT n.nspname||'.'||c.relname AS relation_name,c.oid,c.reltuples::bigint AS estimated_rows
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','m') AND n.nspname IN ('public','private','analytics','auth','storage','cron','net')
  ), rows AS (
    SELECT relations.relation_name,pg_total_relation_size(relations.oid) AS total_bytes,
      pg_relation_size(relations.oid) AS table_bytes,relations.estimated_rows,
      COALESCE(rules.retention_rule,'Unassigned: requires a retention decision') AS retention_rule,
      rules.worker IS NOT NULL AS automatically_pruned,
      status.last_checked_at,status.last_pruned_at,COALESCE(status.rows_pruned,0) AS rows_pruned,
      status.last_rows_pruned,status.last_error
    FROM relations LEFT JOIN private.retention_rules rules USING(relation_name)
    LEFT JOIN private.retention_status status USING(relation_name)
  )
  SELECT jsonb_build_object('tables',COALESCE(jsonb_agg(to_jsonb(rows) ORDER BY relation_name),'[]'::jsonb),
    'external',jsonb_build_array(
      jsonb_build_object('name','Vercel and Edge logs','rule','External provider retention; no database copy'),
      jsonb_build_object('name','Avatar files','rule','Upsert one file per supported format per user; 5 MB each; object deletion requires Storage API'),
      jsonb_build_object('name','Replay evidence','rule','Verified receipt summaries stay in replay artifacts after database log expiry')))
  FROM rows;
$$;

REVOKE ALL ON FUNCTION private.retain_sync_runs(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_sync_runs(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_edge_invocations(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_edge_invocations(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_cron_job_run_details(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_cron_job_run_details(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_pg_net_responses(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_pg_net_responses(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_notification_outbox(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_notification_outbox(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_sleeper_projection_rows(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_sleeper_projection_rows(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_projection_sync_runs(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_projection_sync_runs(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_sync_jobs(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_sync_jobs(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_lineup_tipoff_members(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_lineup_tipoff_members(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_lineup_tipoff_dispatches(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_lineup_tipoff_dispatches(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_matchup_forecasts(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_matchup_forecasts(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_matchup_forecast_queue(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_matchup_forecast_queue(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_trade_estimate_quotes(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_trade_estimate_quotes(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.retain_league_change_hints(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_league_change_hints(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION private.run_retention(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.run_retention(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.retention_dashboard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_dashboard() TO service_role;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('retention-prune','cleanup-trade-estimates');


REVOKE ALL ON FUNCTION private.retain_auth_refresh_tokens(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_auth_refresh_tokens(timestamptz) TO service_role;

REVOKE ALL ON FUNCTION private.retain_auth_sessions(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_auth_sessions(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
  v_utc timestamp:=p_now AT TIME ZONE 'UTC'; v_key text:=date_trunc('minute',p_now)::text;
BEGIN
  PERFORM private.enqueue_close_expired_nominations(p_now);
  PERFORM private.enqueue_stats_sync_dispatch(p_now);
  PERFORM private.enqueue_process_trades(p_now);
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  PERFORM private.enqueue_matchup_forecasts(p_now);
  PERFORM private.enqueue_screen_views(p_now);
  PERFORM private.work_enqueue('player-stats-hints',v_key,p_now);
  PERFORM private.work_enqueue('league-inventory-hint-drain',v_key,p_now,'{"delay":0}');
  PERFORM private.work_enqueue('league-inventory-hint-drain',v_key||':30',p_now,'{"delay":30}');
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    PERFORM private.enqueue_daily('sync-players',6,0,p_now);
    PERFORM private.enqueue_player_injuries(p_now);
    PERFORM private.enqueue_daily('process-waivers',3,0,p_now);
    PERFORM private.enqueue_season_boundary(p_now);
    PERFORM private.enqueue_projection_sync(p_now);
    IF (p_now AT TIME ZONE 'America/New_York')::time>=time '06:20' AND EXISTS(
      SELECT 1 FROM public.nba_games WHERE game_date BETWEEN (p_now AT TIME ZONE 'America/New_York')::date-7
      AND (p_now AT TIME ZONE 'America/New_York')::date-1 AND nba_game_id LIKE '002%' AND status='Final'
    ) THEN
      PERFORM private.work_enqueue('daily-stat-corrections',(p_now AT TIME ZONE 'America/New_York')::date::text,p_now);
    END IF;
  END IF;
  IF v_min%15=5 THEN PERFORM private.enqueue_daily('sync-schedule',6,5,p_now); END IF;
  IF v_min=0 THEN PERFORM private.enqueue_rankings(p_now); END IF;
  IF v_min%5=0 THEN PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now); END IF;
  IF v_min=17 THEN PERFORM private.work_enqueue('pg-net-response-vacuum',date_trunc('hour',p_now)::text,p_now,'{"action":"vacuum"}'); END IF;
  IF v_min=0 AND extract(hour FROM v_utc)=13 AND
    ((extract(month FROM v_utc)=6 AND extract(day FROM v_utc)>=20) OR
     (extract(month FROM v_utc)=7 AND extract(day FROM v_utc)<=15)) THEN
    PERFORM private.work_enqueue('sync-draft-order',v_utc::date::text,p_now);
  END IF;
  IF extract(hour FROM v_utc)=8 AND v_min=35 THEN PERFORM private.work_enqueue('cleanup-trade-estimates',v_utc::date::text,p_now); END IF;
  IF extract(hour FROM v_utc)=9 AND v_min=30 THEN PERFORM private.work_enqueue('mock-room-expiry',v_utc::date::text,p_now); END IF;
  IF v_utc::time>=time '10:00' THEN
    PERFORM private.work_enqueue('retention-prune',v_utc::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_execute(p_id bigint,p_token uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE; v_function text; v_payload jsonb; v_tipoff timestamptz;
  v_previous text:=coalesce(current_setting('pancake.work_id',true),'');
BEGIN
  SELECT * INTO v_item FROM private.work_items WHERE id=p_id AND lease_token=p_token AND status='running' AND lease_until>now();
  IF NOT FOUND THEN RETURN; END IF;
  SELECT function_name INTO v_function FROM private.work_kinds WHERE kind=v_item.kind;
  v_payload:=v_item.payload;
  IF v_item.kind='league-inventory-hint-drain' AND (v_payload->>'delay')::int=0 THEN v_function:=NULL; END IF;
  IF v_item.kind='pre-tipoff' THEN
    v_tipoff:=(v_payload->>'tipoffAt')::timestamptz;
    IF v_tipoff<=now()-interval '1 minute' THEN RAISE EXCEPTION 'Tipoff window has closed'; END IF;
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date) VALUES(v_tipoff,(v_tipoff AT TIME ZONE 'America/New_York')::date) ON CONFLICT DO NOTHING;
    UPDATE public.lineup_tipoff_dispatches SET status='queued',token=p_token,attempts=attempts+1,
      lease_until=v_item.lease_until,error=NULL,input_revision=input_revision+(input_fingerprint IS DISTINCT FROM v_payload->>'fingerprint')::int,
      input_fingerprint=v_payload->>'fingerprint' WHERE tipoff_at=v_tipoff;
    v_payload:=(v_payload-'fingerprint')||jsonb_build_object('token',p_token);
  END IF;
  IF v_function IS NOT NULL THEN
    PERFORM set_config('pancake.work_id',p_id::text,true);
    PERFORM public.invoke_edge_function(v_function,v_payload);
    PERFORM set_config('pancake.work_id',v_previous,true);
    RETURN;
  END IF;
  CASE v_item.kind
    WHEN 'setup-season-rollover' THEN PERFORM private.roll_setup_league_seasons(now());
    WHEN 'daily-stat-corrections' THEN PERFORM public.queue_daily_stat_corrections();
    WHEN 'edge-invocation-reconcile' THEN PERFORM private.reconcile_edge_invocations();
    WHEN 'player-stats-hints' THEN PERFORM private.flush_player_stats_hints();
    WHEN 'league-inventory-hint-drain' THEN PERFORM private.flush_league_inventory_hints(1000);
    WHEN 'cleanup-trade-estimates' THEN PERFORM public.cleanup_trade_estimate_quotes();
    WHEN 'mock-room-expiry' THEN PERFORM public.expire_mock_draft_rooms();
    WHEN 'retention-prune' THEN
      PERFORM private.run_retention();
    ELSE RAISE EXCEPTION 'Unknown SQL work kind: %',v_item.kind;
  END CASE;
  PERFORM private.work_finish(p_id,p_token);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_request_receipts(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.request_id FROM private.request_receipts r WHERE r.created_at<p_now-interval '7 days'
    ORDER BY r.created_at,r.request_id LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.request_receipts r USING victims v WHERE r.request_id=v.request_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.request_receipts',v_count);
END;
$$;

REVOKE ALL ON FUNCTION private.retain_request_receipts(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_request_receipts(timestamptz) TO service_role;

INSERT INTO private.retention_rules(relation_name,retention_rule,worker,run_order) VALUES('private.request_receipts','Request replay results: 7 days; 20000 rows per batch','retain_request_receipts',160)
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule,worker=EXCLUDED.worker,run_order=EXCLUDED.run_order;

CREATE OR REPLACE FUNCTION private.retain_perf_beacons(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.perf_beacons r WHERE r.received_at<p_now-interval '30 days'
    ORDER BY r.received_at,r.id LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.perf_beacons r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.perf_beacons',v_count);
END;
$$;

REVOKE ALL ON FUNCTION private.retain_perf_beacons(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_perf_beacons(timestamptz) TO service_role;

INSERT INTO private.retention_rules(relation_name,retention_rule,worker,run_order) VALUES('public.perf_beacons','Performance samples: 30 days; 20000 rows per batch','retain_perf_beacons',160)
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule,worker=EXCLUDED.worker,run_order=EXCLUDED.run_order;

CREATE OR REPLACE FUNCTION private.retain_work_items(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM private.work_items r WHERE r.status='succeeded' AND r.completed_at<p_now-interval '7 days'
    ORDER BY r.completed_at,r.id LIMIT 20000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.work_items r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.work_items',v_count);
END;
$$;

REVOKE ALL ON FUNCTION private.retain_work_items(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.retain_work_items(timestamptz) TO service_role;

INSERT INTO private.retention_rules(relation_name,retention_rule,worker,run_order) VALUES('private.work_items','Successful work: 7 days; pending, running, failed, and dead work stays; 20000 rows per batch','retain_work_items',160)
ON CONFLICT(relation_name) DO UPDATE SET retention_rule=EXCLUDED.retention_rule,worker=EXCLUDED.worker,run_order=EXCLUDED.run_order;
