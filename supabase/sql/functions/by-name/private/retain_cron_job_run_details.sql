-- Canonical SQL source for private.retain_cron_job_run_details.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.retain_cron_job_run_details(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.ctid AS row_tid FROM cron.job_run_details r
    WHERE (r.status IN ('succeeded','failed') AND COALESCE(r.end_time,r.start_time)<p_now-interval '24 hours')
      OR (r.status NOT IN ('succeeded','failed') AND r.start_time<p_now-interval '24 hours'
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity active
          WHERE active.pid=r.job_pid AND active.backend_start<=r.start_time))
    ORDER BY r.runid LIMIT 512 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM cron.job_run_details r WHERE r.ctid=ANY(ARRAY(SELECT row_tid FROM victims));
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('cron.job_run_details',v_count);
END;
$$;
