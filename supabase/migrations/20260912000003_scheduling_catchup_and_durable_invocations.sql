-- Scheduling hardening, driven by the 2026-09-12 local probes (WORKLOG iteration 6):
--
-- 1. Minute-exact ET gates dropped a whole day (or week) whenever pg_cron ran
--    late. Gates are now "due from the target time onward" with a once-per-
--    period claim in cron_dispatch_state, so a delayed tick is caught up by the
--    next one and never double-dispatched. The claim rides on the job's
--    transaction: a failed invoke rolls it back.
-- 2. invoke_edge_function was fire-and-forget: a request that never booted the
--    function left no sync_runs row. Every invocation now records its pg_net
--    request id in edge_invocations, and reconcile_edge_invocations (cron, every
--    5 minutes) copies the response and writes a failed sync_runs row for a
--    transport error, non-2xx status, or a missing response after 2 hours.
-- 3. A Final game whose box score was never written did not wake live-poll
--    (its gate only looked at non-Final games). It does now.
-- 4. renew_live_poll_lease lets a running poll extend its 90 s lease; a holder
--    that lost the lease is told so.
-- Canonical sources: supabase/sql/functions/by-name/{public,private}/...

CREATE TABLE IF NOT EXISTS public.cron_dispatch_state (
  job_key text PRIMARY KEY,
  period_key text NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.cron_dispatch_state FROM PUBLIC;
REVOKE ALL ON TABLE public.cron_dispatch_state FROM anon;
REVOKE ALL ON TABLE public.cron_dispatch_state FROM authenticated;
GRANT SELECT ON TABLE public.cron_dispatch_state TO service_role;

CREATE TABLE IF NOT EXISTS public.edge_invocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  function_name text NOT NULL,
  request_id bigint,
  queued_at timestamptz NOT NULL DEFAULT now(),
  status_code integer,
  error_message text,
  reconciled_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_edge_invocations_unreconciled
  ON public.edge_invocations (queued_at)
  WHERE reconciled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_edge_invocations_reconciled_at
  ON public.edge_invocations (reconciled_at);
REVOKE ALL ON TABLE public.edge_invocations FROM PUBLIC;
REVOKE ALL ON TABLE public.edge_invocations FROM anon;
REVOKE ALL ON TABLE public.edge_invocations FROM authenticated;
GRANT SELECT ON TABLE public.edge_invocations TO service_role;

-- The old three-argument signatures are replaced by ones with a p_now default.
DROP FUNCTION IF EXISTS public.invoke_edge_function_at_et_time(text, integer, integer);
DROP FUNCTION IF EXISTS public.invoke_dynasty_ranking_views_at_et_time(integer, integer);
DROP FUNCTION IF EXISTS public.invoke_season_boundary_if_due();

CREATE OR REPLACE FUNCTION private.claim_cron_dispatch(
  p_job_key text,
  p_period_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  -- One dispatch per (job, period). The first tick at or after the target time
  -- wins; every later tick in the same period is a no-op, so a delayed or
  -- missed tick is caught up by the next one without double-dispatching. The
  -- claim rides on the caller's transaction: if the invoke raises, it rolls back.
  INSERT INTO public.cron_dispatch_state (job_key, period_key, dispatched_at)
  VALUES (p_job_key, p_period_key, now())
  ON CONFLICT (job_key) DO UPDATE
     SET period_key = EXCLUDED.period_key,
         dispatched_at = EXCLUDED.dispatched_at
   WHERE public.cron_dispatch_state.period_key <> EXCLUDED.period_key
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

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
      'Content-Type', 'application/json'
    ),
    30000
  ) INTO _request_id;

  -- pg_net is fire-and-forget; the request id is the only handle on the
  -- outcome. private.reconcile_edge_invocations() turns the response (or its
  -- absence) into a durable sync_runs failure row.
  INSERT INTO public.edge_invocations (function_name, request_id)
  VALUES (function_name, _request_id);
END;
$$;

CREATE OR REPLACE FUNCTION private.reconcile_edge_invocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reconciled integer := 0;
  v_row record;
BEGIN
  -- pg_net writes net._http_response asynchronously and purges it after a few
  -- hours, so responses are copied onto the durable edge_invocations row.
  -- A non-2xx status, a transport error, or no response at all within the
  -- grace window becomes a failed sync_runs row: the documented health surface
  -- previously showed nothing when the function never booted.
  FOR v_row IN
    SELECT inv.id, inv.function_name, inv.request_id, inv.queued_at,
           resp.status_code, resp.error_msg, resp.timed_out, left(resp.content, 500) AS content
      FROM public.edge_invocations AS inv
      LEFT JOIN net._http_response AS resp ON resp.id = inv.request_id
     WHERE inv.reconciled_at IS NULL
       AND inv.queued_at < now() - interval '1 minute'
     ORDER BY inv.queued_at
     LIMIT 500
     FOR UPDATE OF inv SKIP LOCKED
  LOOP
    IF v_row.status_code IS NULL AND v_row.error_msg IS NULL AND v_row.timed_out IS NOT TRUE THEN
      -- Nothing recorded yet. Wait up to the grace window, then fail closed.
      IF v_row.queued_at >= now() - interval '2 hours' THEN
        CONTINUE;
      END IF;
      UPDATE public.edge_invocations
         SET error_message = 'no response recorded within 2 hours (request never sent or pg_net purged it)',
             reconciled_at = now()
       WHERE id = v_row.id;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed',
              'no response recorded within 2 hours (request never sent or pg_net purged it)');
    ELSIF v_row.error_msg IS NOT NULL OR v_row.timed_out IS TRUE OR v_row.status_code >= 400 THEN
      UPDATE public.edge_invocations
         SET status_code = v_row.status_code,
             error_message = COALESCE(v_row.error_msg, CASE WHEN v_row.timed_out THEN 'timed out' END, 'HTTP ' || v_row.status_code || ': ' || COALESCE(v_row.content, '')),
             reconciled_at = now()
       WHERE id = v_row.id;
      INSERT INTO public.sync_runs (function_name, started_at, finished_at, status, error)
      VALUES ('cron:' || v_row.function_name, v_row.queued_at, now(), 'failed',
              COALESCE(v_row.error_msg, CASE WHEN v_row.timed_out THEN 'timed out' END, 'HTTP ' || v_row.status_code || ': ' || COALESCE(v_row.content, '')));
    ELSE
      UPDATE public.edge_invocations
         SET status_code = v_row.status_code,
             reconciled_at = now()
       WHERE id = v_row.id;
    END IF;
    v_reconciled := v_reconciled + 1;
  END LOOP;

  DELETE FROM public.edge_invocations
   WHERE reconciled_at < now() - interval '30 days';

  RETURN v_reconciled;
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
  PERFORM public.invoke_edge_function(p_function_name);
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
  -- Weekly: due on Monday from the target ET time, and on any later tick that
  -- week if Monday was missed; dispatched once per ISO week.
  IF EXTRACT(ISODOW FROM v_now)::int = 1 AND v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:sync-rankings', to_char(v_now, 'IYYY-IW')) THEN
    RETURN;
  END IF;
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_3"}'::jsonb);
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"ROOKIE"}'::jsonb);
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_5"}'::jsonb);
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
  PERFORM public.invoke_edge_function('season-boundary');
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := (timezone('America/New_York', now()))::date;
BEGIN
  -- Mirrors livePollCandidateDates() in the edge function: yesterday + today
  -- ET, so late West-coast games that cross ET midnight stay covered.
  -- A game already marked Final whose box score was never written (the
  -- function was down when it ended) must also wake the poll, or its stats
  -- are never fetched.
  IF EXISTS (
    SELECT 1
      FROM public.nba_games
     WHERE game_date IN (v_today - 1, v_today)
       AND status <> 'Final'
  ) OR EXISTS (
    SELECT 1
      FROM public.nba_games AS game
     WHERE game.game_date IN (v_today - 1, v_today)
       AND game.status = 'Final'
       AND NOT EXISTS (
         SELECT 1 FROM public.player_game_stats AS stat WHERE stat.game_id = game.id
       )
  ) THEN
    PERFORM public.invoke_edge_function('live-poll');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_live_poll_lease(
  p_lock_key    bigint,
  p_holder_id   uuid,
  p_ttl_seconds integer DEFAULT 90
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  -- Only the current, unexpired holder may extend its lease. A holder that
  -- already lost the lease (TTL lapsed and another worker took over) gets
  -- false and must stop treating itself as the poller.
  UPDATE public.live_poll_leases
     SET expires_at = v_now + make_interval(secs => GREATEST(p_ttl_seconds, 1))
   WHERE lock_key  = p_lock_key
     AND holder_id = p_holder_id
     AND expires_at >= v_now;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION private.claim_cron_dispatch(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reconcile_edge_invocations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, integer, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, integer, integer, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_edge_function_at_et_time(text, integer, integer, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function_at_et_time(text, integer, integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(integer, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(integer, integer, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(integer, integer, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_dynasty_ranking_views_at_et_time(integer, integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.invoke_season_boundary_if_due(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_season_boundary_if_due(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_season_boundary_if_due(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_season_boundary_if_due(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.renew_live_poll_lease(bigint, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_live_poll_lease(bigint, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.renew_live_poll_lease(bigint, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.renew_live_poll_lease(bigint, uuid, integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'edge-invocation-reconcile';
    PERFORM cron.schedule(
      'edge-invocation-reconcile',
      '*/5 * * * *',
      $job$SELECT private.reconcile_edge_invocations()$job$
    );
  END IF;
END $$;
