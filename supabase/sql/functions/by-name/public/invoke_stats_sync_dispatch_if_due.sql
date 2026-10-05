-- Canonical SQL source for public.invoke_stats_sync_dispatch_if_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.invoke_stats_sync_dispatch_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- One cron period ahead, as in invoke_close_expired_nominations_if_due: a
  -- retry or stale lease that falls due before the edge function claims is
  -- still picked up on this tick.
  v_horizon timestamptz := now() + interval '1 minute';
BEGIN
  -- Mirrors both candidate queries of claim_stats_sync_job_atomic (valid jobs
  -- and malformed ones it dead-letters), with the dispatcher's 120 s stale
  -- lease (p_stale_after_seconds in sync-stats).
  IF EXISTS (
    SELECT 1
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND (
         job.status = 'pending'
         OR (
           job.status = 'failed'
           AND job.failed_items < 3
           AND COALESCE(job.completed_at, job.created_at) <= v_horizon - make_interval(
             secs => CASE WHEN job.failed_items <= 1 THEN 60 ELSE 300 END
           )
         )
         OR (
           job.status = 'running'
           AND (
             (
               job.claim_token IS NULL
               AND COALESCE(job.claimed_at, job.created_at) <= v_horizon - interval '15 minutes'
             )
             OR (
               job.claim_token IS NOT NULL
               AND (
                 job.claimed_at IS NULL
                 OR job.claimed_at <= v_horizon - interval '120 seconds'
               )
             )
           )
         )
       )
  ) THEN
    PERFORM public.invoke_edge_function(
      'sync-stats',
      '{"dispatch":true,"jobId":"00000000-0000-4000-8000-000000000000"}'::jsonb
    );
  END IF;
END;
$$;
