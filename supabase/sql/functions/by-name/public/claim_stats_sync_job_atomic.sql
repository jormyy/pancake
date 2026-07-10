-- Canonical SQL source for public.claim_stats_sync_job_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.claim_stats_sync_job_atomic(
  p_job_id uuid DEFAULT NULL,
  p_stale_after_seconds integer DEFAULT 120
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  job_type text,
  completed_items integer,
  total_items integer,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stale_after_seconds integer := LEAST(GREATEST(COALESCE(p_stale_after_seconds, 120), 60), 900);
  v_max_failed_attempts constant integer := 3;
BEGIN
  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
      FROM public.sync_jobs AS job
     WHERE job.job_type LIKE 'sync_stats_range:%'
       AND (p_job_id IS NULL OR job.id = p_job_id)
       AND (
         job.status = 'pending'
         OR (
           job.status = 'failed'
           AND job.failed_items < v_max_failed_attempts
           AND COALESCE(job.completed_at, job.created_at) <= now() - make_interval(
             secs => CASE WHEN job.failed_items <= 1 THEN 60 ELSE 300 END
           )
         )
         OR (
         job.status = 'running'
           AND (
             (
               job.claim_token IS NULL
               AND COALESCE(job.claimed_at, job.created_at) <= now() - interval '15 minutes'
             )
             OR (
               job.claim_token IS NOT NULL
               AND (
                 job.claimed_at IS NULL
                 OR job.claimed_at <= now() - make_interval(secs => v_stale_after_seconds)
               )
             )
           )
         )
       )
     ORDER BY job.created_at, job.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.sync_jobs AS job
       SET status = 'running',
           claimed_at = now(),
           claim_token = gen_random_uuid(),
           completed_at = NULL
      FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.claim_token, job.job_type, job.completed_items,
       job.total_items, job.metadata
  )
  SELECT claimed.id, claimed.claim_token, claimed.job_type, claimed.completed_items,
    claimed.total_items, claimed.metadata
  FROM claimed;
END;
$$;
