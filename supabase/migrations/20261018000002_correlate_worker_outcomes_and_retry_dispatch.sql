SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE public.edge_invocations
  ADD COLUMN invocation_key uuid,
  ADD COLUMN dispatch_job_key text,
  ADD COLUMN dispatch_period_key text,
  ADD COLUMN dispatch_claimed_at timestamptz,
  ADD COLUMN worker_started_at timestamptz,
  ADD COLUMN worker_finished_at timestamptz,
  ADD COLUMN worker_status text,
  ADD COLUMN sync_run_id uuid;
CREATE UNIQUE INDEX edge_invocations_invocation_key ON public.edge_invocations (invocation_key) WHERE invocation_key IS NOT NULL;
CREATE INDEX edge_invocations_dispatch_claim ON public.edge_invocations (dispatch_job_key, dispatch_period_key, dispatch_claimed_at)
  WHERE dispatch_job_key IS NOT NULL;
ALTER TABLE public.cron_dispatch_state
  ADD COLUMN attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN retry_after timestamptz;

CREATE OR REPLACE FUNCTION public.invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _base_url text;
  _internal_token text;
  _request_id bigint;
  _invocation_key uuid := gen_random_uuid();
  _claim public.cron_dispatch_state%ROWTYPE;
BEGIN
  _base_url := NULLIF(rtrim(current_setting('app.supabase_url', true), '/'), '');
  _internal_token := NULLIF(current_setting('app.edge_internal_token', true), '');

  -- Managed Supabase denies ALTER DATABASE/ROLE SET for app.* GUCs, so the
  -- base URL falls back to Vault exactly like the internal token does. The
  -- missing GUC silently killed every cron->edge invocation from 2026-06-28
  -- to 2026-08-15.
  IF _base_url IS NULL THEN
    SELECT NULLIF(rtrim(decrypted_secret, '/'), '')
      INTO _base_url
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_supabase_url'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _internal_token IS NULL THEN
    SELECT NULLIF(decrypted_secret, '')
      INTO _internal_token
      FROM vault.decrypted_secrets
     WHERE name = 'pancake_edge_internal_token'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1;
  END IF;

  IF _base_url IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge base URL is not configured.';
  END IF;

  IF _internal_token IS NULL THEN
    RAISE EXCEPTION '[cron] Supabase Edge internal token is not configured.';
  END IF;

  SELECT net.http_post(
    _base_url || '/functions/v1/' || function_name,
    body,
    NULL,
    jsonb_build_object(
      'x-internal-function-token', _internal_token,
      'Content-Type', 'application/json',
      'x-pancake-invocation-id', _invocation_key::text
    ),
    30000
  ) INTO _request_id;

  SELECT * INTO _claim FROM public.cron_dispatch_state
   WHERE job_key = NULLIF(current_setting('pancake.cron_job_key', true), '');
  INSERT INTO public.edge_invocations (
    function_name, request_id, invocation_key, dispatch_job_key, dispatch_period_key, dispatch_claimed_at
  ) VALUES (
    function_name, _request_id, _invocation_key, _claim.job_key, _claim.period_key, _claim.dispatched_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.invoke_claimed_edge_function(
  p_job_key text,
  p_function_name text,
  p_body jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous text := COALESCE(current_setting('pancake.cron_job_key', true), '');
BEGIN
  PERFORM set_config('pancake.cron_job_key', p_job_key, true);
  PERFORM public.invoke_edge_function(p_function_name, p_body);
  PERFORM set_config('pancake.cron_job_key', v_previous, true);
END;
$$;

CREATE OR REPLACE FUNCTION private.claim_cron_dispatch(
  p_job_key text,
  p_period_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  INSERT INTO public.cron_dispatch_state (job_key, period_key, dispatched_at)
  VALUES (p_job_key, p_period_key, clock_timestamp())
  ON CONFLICT (job_key) DO UPDATE
     SET period_key = EXCLUDED.period_key,
         dispatched_at = EXCLUDED.dispatched_at,
         attempts = CASE WHEN cron_dispatch_state.period_key = EXCLUDED.period_key
           THEN cron_dispatch_state.attempts + 1 ELSE 1 END,
         retry_after = NULL
   WHERE cron_dispatch_state.period_key <> EXCLUDED.period_key
      OR (cron_dispatch_state.retry_after <= clock_timestamp() AND cron_dispatch_state.attempts < 3)
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_edge_function_at_et_time(
  p_function_name text,
  p_hour int,
  p_minute int DEFAULT 0,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Due from the target ET time onward, dispatched at most once per ET day.
  -- Equality on the minute skipped the whole day whenever pg_cron ran late.
  IF v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:' || p_function_name, to_char(v_now, 'YYYY-MM-DD')) THEN
    RETURN;
  END IF;
  PERFORM private.invoke_claimed_edge_function('et-time:' || p_function_name, p_function_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_season_boundary_if_due(
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Due from 09:00 ET onward, once per ET day; a tick delayed past the 9 o'clock
  -- hour used to skip the whole day's bracket/rollover work.
  IF v_now::time < make_time(9, 0, 0) THEN
    RETURN;
  END IF;

  -- Setup leagues have no bracket work, but one whose season ended before it
  -- drafted moves to the next season.
  PERFORM private.roll_setup_league_seasons(p_now);

  IF NOT EXISTS (
    SELECT 1
      FROM public.leagues
     WHERE status IN (
       'active'::public.league_status,
       'playoffs'::public.league_status,
       'offseason'::public.league_status
     )
  ) THEN
    RETURN;
  END IF;

  IF NOT private.claim_cron_dispatch('season-boundary', to_char(v_now, 'YYYY-MM-DD')) THEN
    RETURN;
  END IF;
  PERFORM private.invoke_claimed_edge_function('season-boundary', 'season-boundary');
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_dynasty_ranking_views_at_et_time(
  p_hour int,
  p_minute int DEFAULT 0,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Direct calls later in the week can catch up, once per ISO week.
  -- The installed cron only calls this on Mondays; it cannot retry on Tuesday.
  IF EXTRACT(ISODOW FROM v_now)::int = 1 AND v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:sync-rankings', to_char(v_now, 'IYYY-IW')) THEN
    RETURN;
  END IF;
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"POINT_3"}'::jsonb);
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"ROOKIE"}'::jsonb);
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"POINT_5"}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.start_edge_invocation(
  p_invocation_key uuid,
  p_function_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.edge_invocations%ROWTYPE;
  v_run uuid;
BEGIN
  SELECT * INTO v_inv FROM public.edge_invocations
   WHERE invocation_key = p_invocation_key AND function_name = p_function_name
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown invocation for this function'; END IF;
  IF v_inv.worker_started_at IS NOT NULL OR v_inv.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invocation already started or settled';
  END IF;
  IF v_inv.queued_at < clock_timestamp() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Invocation expired before worker startup';
  END IF;
  INSERT INTO public.sync_runs (function_name, started_at)
  VALUES (p_function_name, clock_timestamp()) RETURNING id INTO v_run;
  UPDATE public.edge_invocations
     SET worker_started_at = clock_timestamp(), worker_status = 'running', sync_run_id = v_run
   WHERE id = v_inv.id;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_edge_invocation(
  p_invocation_key uuid,
  p_status text,
  p_rows_affected integer DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.edge_invocations%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'Invalid worker outcome';
  END IF;
  SELECT * INTO v_inv FROM public.edge_invocations WHERE invocation_key = p_invocation_key FOR UPDATE;
  IF NOT FOUND OR v_inv.worker_started_at IS NULL THEN RAISE EXCEPTION 'Invocation has no worker'; END IF;
  IF v_inv.worker_finished_at IS NOT NULL THEN RETURN; END IF;
  UPDATE public.sync_runs
     SET status = p_status, rows_affected = p_rows_affected, error = left(p_error, 4000),
         finished_at = clock_timestamp()
   WHERE id = v_inv.sync_run_id;
  UPDATE public.edge_invocations
     SET worker_status = p_status, worker_finished_at = clock_timestamp(), reconciled_at = NULL
   WHERE id = v_inv.id;
END;
$$;

CREATE OR REPLACE FUNCTION private.reconcile_edge_invocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reconciled integer := 0;
  v_row record;
  v_claim record;
  v_error text;
  v_run uuid;
BEGIN
  FOR v_row IN
    SELECT inv.*, resp.status_code AS response_status, resp.error_msg, resp.timed_out,
           left(resp.content, 500) AS content
      FROM public.edge_invocations AS inv
      LEFT JOIN net._http_response AS resp ON resp.id = inv.request_id
     WHERE inv.reconciled_at IS NULL AND inv.queued_at < now() - interval '1 minute'
     ORDER BY inv.queued_at LIMIT 500 FOR UPDATE OF inv SKIP LOCKED
  LOOP
    v_error := CASE
      WHEN v_row.error_msg IS NOT NULL THEN v_row.error_msg
      WHEN v_row.timed_out IS TRUE THEN 'timed out'
      WHEN v_row.response_status NOT BETWEEN 200 AND 299
        THEN 'HTTP ' || v_row.response_status || ': ' || COALESCE(v_row.content, '')
      ELSE NULL END;
    UPDATE public.edge_invocations
       SET status_code = v_row.response_status, error_message = v_error WHERE id = v_row.id;

    IF v_row.worker_started_at IS NOT NULL THEN
      IF v_row.worker_finished_at IS NULL THEN
        IF v_row.worker_started_at >= now() - interval '10 minutes' THEN CONTINUE; END IF;
        UPDATE public.sync_runs SET status = 'failed', finished_at = now(),
          error = 'worker did not finish within 10 minutes' WHERE id = v_row.sync_run_id;
        UPDATE public.edge_invocations SET worker_status = 'failed' WHERE id = v_row.id;
      END IF;
    ELSIF v_row.response_status BETWEEN 200 AND 299 AND v_error IS NULL THEN
      NULL;
    ELSE
      IF v_row.invocation_key IS NOT NULL AND v_row.queued_at >= now() - interval '10 minutes' THEN
        CONTINUE;
      END IF;
      IF v_error IS NULL THEN
        IF v_row.invocation_key IS NULL AND v_row.queued_at >= now() - interval '2 hours' THEN CONTINUE; END IF;
        v_error := CASE WHEN v_row.invocation_key IS NULL THEN
          'no response recorded within 2 hours (request never sent or pg_net purged it)'
          ELSE 'no worker or response recorded within 10 minutes' END;
      END IF;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed', v_error)
      RETURNING id INTO v_run;
      UPDATE public.edge_invocations SET sync_run_id = v_run, error_message = v_error WHERE id = v_row.id;
    END IF;
    UPDATE public.edge_invocations SET reconciled_at = now() WHERE id = v_row.id;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  FOR v_claim IN
    SELECT * FROM public.cron_dispatch_state WHERE attempts < 3 FOR UPDATE SKIP LOCKED
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
    ) AND NOT EXISTS (
      SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
       AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
       AND reconciled_at IS NULL
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.edge_invocations WHERE dispatch_job_key = v_claim.job_key
         AND dispatch_period_key = v_claim.period_key AND dispatch_claimed_at = v_claim.dispatched_at
         AND (worker_status = 'failed' OR (worker_status IS NULL
           AND (status_code IS NULL OR status_code NOT BETWEEN 200 AND 299)))
      ) THEN
        UPDATE public.cron_dispatch_state SET retry_after = clock_timestamp() + interval '5 minutes'
         WHERE job_key = v_claim.job_key AND retry_after IS NULL;
      ELSE
        UPDATE public.cron_dispatch_state SET retry_after = NULL
         WHERE job_key = v_claim.job_key AND retry_after IS NOT NULL;
      END IF;
    END IF;
  END LOOP;
  RETURN v_reconciled;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_unbounded_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sync_runs bigint := 0;
  v_edge_invocations bigint := 0;
  v_cron_runs bigint := 0;
  v_functions text[] := ARRAY['live-poll','sync-stats','sync-scores','close-expired-nominations','process-trades','source:nba-cdn-scoreboard'];
  v_cron_jobs text[] := ARRAY['nba-live-poll','nba-sync-stats','nba-sync-scores','nba-close-expired-nominations','nba-process-trades','nba-dispatch-stats-sync-jobs','edge-invocation-reconcile','pg-net-response-vacuum'];
BEGIN
  DELETE FROM public.sync_runs
   WHERE function_name = ANY(v_functions)
     AND status = 'success'
     AND error IS NULL
     AND finished_at < now() - interval '7 days';
  GET DIAGNOSTICS v_sync_runs = ROW_COUNT;

  DELETE FROM public.edge_invocations
   WHERE function_name = ANY(v_functions)
     AND status_code BETWEEN 200 AND 299
     AND error_message IS NULL
     AND worker_status IS DISTINCT FROM 'failed'
     AND (worker_started_at IS NULL OR worker_finished_at IS NOT NULL)
     AND reconciled_at < now() - interval '7 days';
  GET DIAGNOSTICS v_edge_invocations = ROW_COUNT;

  IF to_regclass('cron.job_run_details') IS NOT NULL THEN
    DELETE FROM cron.job_run_details AS run
     WHERE run.status = 'succeeded'
       AND run.end_time < now() - interval '7 days'
       AND (
         EXISTS (SELECT 1 FROM cron.job AS job WHERE job.jobid = run.jobid AND job.jobname = ANY(v_cron_jobs))
         OR (
           NOT EXISTS (SELECT 1 FROM cron.job AS job WHERE job.jobid = run.jobid)
           AND (run.command ~* '^\s*select\s+(public\.)?invoke_edge_function\(\s*''(live-poll|sync-stats|sync-scores|close-expired-nominations|process-trades)''\s*(,.*)?\s*\)\s*;?\s*$'
             OR run.command ~* '^\s*select\s+(public\.)?invoke_lineup_optimizer_if_due\(\s*\)\s*;?\s*$')
         )
       );
    GET DIAGNOSTICS v_cron_runs = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'sync_runs', v_sync_runs,
    'edge_invocations', v_edge_invocations,
    'cron_job_run_details', v_cron_runs,
    'projection_sync_runs', 0,
    'weekly_lineups', 0,
    'standings', 0,
    'roster_transactions', 0,
    'dynasty_news', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION private.invoke_claimed_edge_function(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_edge_invocation(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_edge_invocation(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_edge_invocation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_edge_invocation(uuid, text, integer, text) TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('nba-sync-players', '*/15 * * * *', $$SELECT public.invoke_edge_function_at_et_time('sync-players', 6, 0)$$);
    PERFORM cron.schedule('nba-sync-schedule', '5,20,35,50 * * * *', $$SELECT public.invoke_edge_function_at_et_time('sync-schedule', 6, 5)$$);
    PERFORM cron.schedule('nba-process-waivers', '*/15 * * * *', $$SELECT public.invoke_edge_function_at_et_time('process-waivers', 3, 0)$$);
    PERFORM cron.schedule('season-boundary', '*/15 * * * *', $$SELECT public.invoke_season_boundary_if_due()$$);
    PERFORM cron.schedule('nba-sync-rankings', '0 * * * *', $$SELECT public.invoke_dynasty_ranking_views_at_et_time(7, 0)$$);
  END IF;
END;
$cron$;

RESET statement_timeout;
RESET lock_timeout;
