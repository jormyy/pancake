CREATE OR REPLACE FUNCTION private.retain_auth_refresh_tokens(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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
    ORDER BY r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM auth.refresh_tokens r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  WITH victims AS (
    SELECT r.id FROM auth.refresh_tokens r
    WHERE r.revoked AND r.updated_at<p_now-interval '7 days'
    ORDER BY r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM auth.refresh_tokens r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_revoked=ROW_COUNT;
  RETURN jsonb_build_object('auth.refresh_tokens',v_count+v_revoked);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_auth_sessions(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_cron_job_run_details(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.runid FROM cron.job_run_details r
    WHERE (r.status IN ('succeeded','failed') AND COALESCE(r.end_time,r.start_time)<p_now-CASE WHEN r.status='succeeded' THEN interval '7 days' ELSE interval '30 days' END)
      OR (r.status NOT IN ('succeeded','failed') AND r.start_time<p_now-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity active
          WHERE active.pid=r.job_pid AND active.backend_start<=r.start_time))
    ORDER BY r.runid LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM cron.job_run_details r USING victims v WHERE r.runid=v.runid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('cron.job_run_details',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_edge_invocations(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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
        ORDER BY r.reconciled_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM public.edge_invocations r USING victims v WHERE r.id=v.id
    $query$,v_condition) USING p_now,v_age;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
  END LOOP;
  RETURN jsonb_build_object('public.edge_invocations',v_total);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_league_change_hints(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_dispatches(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_lineup_tipoff_members(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_matchup_forecast_queue(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_notification_outbox(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.notification_outbox r
    WHERE COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at)<p_now-interval '60 days'
    ORDER BY COALESCE(r.delivered_at,r.dead_lettered_at,r.suppressed_at),r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.notification_outbox r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.notification_outbox',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_perf_beacons(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.perf_beacons r WHERE r.received_at<p_now-interval '30 days'
    ORDER BY r.received_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.perf_beacons r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.perf_beacons',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_pg_net_responses(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM net._http_response r
    WHERE r.created<p_now-interval '6 hours'
      AND NOT EXISTS (SELECT 1 FROM public.edge_invocations i WHERE i.request_id=r.id AND i.reconciled_at IS NULL)
    ORDER BY r.created,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM net._http_response r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('net._http_response',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_projection_sync_runs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_ids uuid[]; v_counts jsonb;
BEGIN
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.projection_sync_runs
    WHERE projection_period_end<date_trunc('week',timezone('America/Los_Angeles',p_now))::date
    ORDER BY projection_period_end,id LIMIT 200
  ) expired;
  v_counts:=private.delete_projection_runs(v_ids,5000);
  RETURN jsonb_build_object('public.projection_sync_runs',COALESCE((v_counts->>'projection_sync_runs')::bigint,0),
    'public.fantasypros_projection_rows',COALESCE((v_counts->>'fantasypros_projection_rows')::bigint,0));
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_request_receipts(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.request_id FROM private.request_receipts r WHERE r.created_at<p_now-interval '7 days'
    ORDER BY r.created_at,r.request_id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.request_receipts r USING victims v WHERE r.request_id=v.request_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.request_receipts',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_sleeper_projection_rows(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint; v_previous text:=COALESCE(current_setting('pancake.projection_cleanup',true),'');
BEGIN
  PERFORM set_config('pancake.projection_cleanup','on',true);
  WITH victims AS (
    SELECT r.id FROM public.sleeper_projection_rows r
    WHERE r.game_date<date_trunc('week',timezone('America/Los_Angeles',p_now))::date
    ORDER BY r.game_date,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.sleeper_projection_rows r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  PERFORM set_config('pancake.projection_cleanup',v_previous,true);
  RETURN jsonb_build_object('public.sleeper_projection_rows',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_sync_jobs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_sync_runs(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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
        ORDER BY r.finished_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
      ) DELETE FROM public.sync_runs r USING victims v WHERE r.id=v.id
    $query$,v_condition) USING p_now,v_age;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
  END LOOP;
  RETURN jsonb_build_object('public.sync_runs',v_total);
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_trade_estimate_quotes(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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

CREATE OR REPLACE FUNCTION private.retain_work_items(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM private.work_items r WHERE r.status='succeeded' AND r.completed_at<p_now-interval '7 days'
    ORDER BY r.completed_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.work_items r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.work_items',v_count);
END;
$$;

CREATE OR REPLACE FUNCTION private.run_retention(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
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
    EXIT WHEN clock_timestamp()-v_started>=interval '2 seconds';
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

CREATE OR REPLACE FUNCTION private.prune_perf_beacons()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '100ms'
SET statement_timeout = '3s'
AS $$
DECLARE
  removed bigint;
BEGIN
  removed := (private.retain_perf_beacons()->>'public.perf_beacons')::bigint;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION private.work_enforce_lease()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_invocation text:=nullif(nullif(current_setting('request.headers',true),'')::jsonb->>'x-pancake-work-key','');
BEGIN
  IF v_invocation IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM private.work_items WHERE invocation_key=v_invocation::uuid AND status='running' AND lease_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Work lease is no longer current' USING ERRCODE='PT409'; END IF;
  RETURN NULL;
END;
$$;

ALTER ROLE service_role SET statement_timeout = '3s';
ALTER ROLE service_role SET lock_timeout = '250ms';
SELECT cron.alter_job(jobid, command := $$SET statement_timeout='5s'; SET lock_timeout='250ms'; SELECT public.dispatch_work();$$) FROM cron.job WHERE jobname='work-dispatcher';
NOTIFY pgrst, 'reload config';

CREATE OR REPLACE FUNCTION private.refresh_queue_screen_views(p_league_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.screen_refresh_queue AS queued(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  WHERE p_league_id IS NULL OR season.league_id = p_league_id
  ORDER BY season.id
  ON CONFLICT (league_season_id) DO UPDATE SET version = queued.version + 1,
    dirty = true, changed_at = now(), available_at = LEAST(queued.available_at, now())
  WHERE NOT queued.dirty OR queued.claimed_at IS NOT NULL AND queued.changed_at IS DISTINCT FROM now();
$$;

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
  IF COALESCE(p_params->>'operation', 'claim') = 'claim' THEN
    WITH candidates AS (
      SELECT league_season_id FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')
      ORDER BY changed_at, league_season_id LIMIT LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 1), 1), 1)
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE private.screen_refresh_queue q SET claimed_at = now(), claim_token = gen_random_uuid(), claimed_version = q.version
      FROM candidates c WHERE q.league_season_id = c.league_season_id RETURNING q.*
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('leagueId', c.league_id, 'seasonId', c.league_season_id,
      'version', c.version, 'claimToken', c.claim_token, 'trades', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('tradeId', trade.id, 'memberId', member.id, 'userId', member.user_id) ORDER BY trade.id)
        FROM (SELECT trade.id, trade.proposer_member_id FROM public.trades trade
          LEFT JOIN public.trade_value_cache cached ON cached.trade_id = trade.id
          WHERE trade.league_season_id = c.league_season_id
            AND (cached.trade_id IS NULL OR cached.version < c.version OR cached.valid_until <= now())
          ORDER BY cached.version NULLS FIRST, trade.id LIMIT 20) trade
        JOIN public.league_members member ON member.id = trade.proposer_member_id), '[]'::jsonb))), '[]'::jsonb) INTO result FROM claimed c;
    RETURN result;
  END IF;
  SELECT * INTO queued FROM private.screen_refresh_queue WHERE league_id = p_league_id
    AND league_season_id = (p_params->>'seasonId')::uuid FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS NULL OR queued.claim_token IS DISTINCT FROM (p_params->>'claimToken')::uuid
    OR queued.claimed_version IS DISTINCT FROM (p_params->>'version')::bigint THEN RETURN 'false'; END IF;
  IF p_params->>'operation' = 'fail' THEN
    UPDATE private.screen_refresh_queue SET claim_token = NULL, claimed_at = NULL, claimed_version = NULL,
      available_at = now() + interval '1 minute', last_error = left(p_params->>'error', 1000) WHERE league_season_id = queued.league_season_id;
    RETURN 'true';
  END IF;
  IF p_params->>'operation' IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'Unknown refresh operation.' USING ERRCODE = '22023'; END IF;
  completed := queued.version = queued.claimed_version;
  IF completed THEN
    PERFORM private.refresh_standings(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_matchup_totals(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_player_averages(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_trade_values(queued.league_id, queued.league_season_id, queued.version, COALESCE(p_params->'tradeValues', '[]'));
    completed := NOT EXISTS (SELECT 1 FROM public.trades trade
      LEFT JOIN public.trade_value_cache cached ON cached.trade_id = trade.id
      WHERE trade.league_season_id = queued.league_season_id
        AND (cached.trade_id IS NULL OR cached.version < queued.version OR cached.valid_until <= now()));
  END IF;
  UPDATE private.screen_refresh_queue SET dirty = NOT completed, claim_token = NULL, claimed_at = NULL,
    claimed_version = NULL, last_error = NULL, available_at = CASE WHEN completed THEN available_at ELSE now() + interval '5 seconds' END WHERE league_season_id = queued.league_season_id;
  RETURN to_jsonb(completed);
END;
$$;

CREATE OR REPLACE FUNCTION private.work_claim(p_limit integer DEFAULT 64)
RETURNS SETOF private.work_items LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  FOR v_item IN SELECT * FROM private.work_items WHERE status='running' AND lease_until<=now()
    ORDER BY lease_until,id LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE private.work_items SET lease_until=now()+interval '1 second' WHERE id=v_item.id;
    PERFORM private.work_finish(v_item.id,v_item.lease_token,'Worker lease expired');
  END LOOP;
  RETURN QUERY
    WITH due AS (SELECT id FROM private.work_items WHERE status IN ('pending','failed') AND due_at<=now()
      ORDER BY due_at,id LIMIT greatest(0,least(p_limit,8-(SELECT count(*)::integer FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp()))) FOR UPDATE SKIP LOCKED)
    UPDATE private.work_items item SET status='running',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
    FROM due WHERE item.id=due.id RETURNING item.*;
END;
$$;
