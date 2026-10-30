-- Canonical SQL source for private.scheduler_health.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.scheduler_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_health jsonb;
BEGIN
  WITH recent AS MATERIALIZED (
    SELECT jobid,status,start_time,end_time,return_message
    FROM cron.job_run_details ORDER BY runid DESC LIMIT 40
  ), window_runs AS MATERIALIZED (
    SELECT * FROM recent WHERE start_time>=v_now-interval '5 minutes' AND start_time<=v_now
  ), runs AS (
    SELECT count(*) AS samples,
      count(*) FILTER(WHERE status='succeeded')::numeric/nullif(count(*),0) AS success_ratio,
      avg(extract(epoch FROM end_time-start_time)) AS avg_duration_seconds,
      max(extract(epoch FROM end_time-start_time)) AS max_duration_seconds,
      max(end_time) AS last_completed_at
    FROM window_runs
    WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='work-dispatcher')
      AND status IN ('succeeded','failed')
  ), timeouts AS (
    SELECT count(*) AS startup_timeouts FROM window_runs
    WHERE return_message LIKE '%job startup timeout%'
  ), backends AS (
    SELECT count(*) FILTER(WHERE state='active') AS active_backends,
      count(*) FILTER(WHERE wait_event_type='Lock') AS lock_waiters
    FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
  )
  SELECT jsonb_build_object('available',true,'checked_at',v_now,'window_seconds',300,
    'row_limit',40,'rows_checked',(SELECT count(*) FROM recent))
    ||to_jsonb(runs)||to_jsonb(timeouts)||to_jsonb(backends)
  INTO v_health FROM runs,timeouts,backends;
  RETURN v_health;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  RETURN jsonb_build_object('available',false,'checked_at',clock_timestamp(),'window_seconds',300,'error_code',SQLSTATE);
END;
$$;
