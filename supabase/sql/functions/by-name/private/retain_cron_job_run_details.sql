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
