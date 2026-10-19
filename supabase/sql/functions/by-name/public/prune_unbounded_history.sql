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
  v_cron_jobs text[] := ARRAY['nba-live-poll','nba-sync-stats','nba-sync-scores','nba-close-expired-nominations','nba-process-trades','nba-dispatch-stats-sync-jobs','edge-invocation-reconcile','pg-net-response-vacuum','league-inventory-hint-drain'];
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
