SET lock_timeout = '5s';
SET statement_timeout = '2min';

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
    ELSIF v_row.error_msg IS NOT NULL OR v_row.timed_out IS TRUE OR v_row.status_code NOT BETWEEN 200 AND 299 THEN
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

  RETURN v_reconciled;
END;
$$;

RESET lock_timeout;
RESET statement_timeout;
