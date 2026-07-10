-- Canonical SQL source for public.fail_stats_sync_job_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.fail_stats_sync_job_atomic(
  p_job_id uuid,
  p_claim_token uuid,
  p_completed_items integer,
  p_metadata jsonb,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job_type text;
BEGIN
  SELECT job_type INTO v_job_type
    FROM public.sync_jobs
   WHERE id = p_job_id AND status = 'running' AND claim_token = p_claim_token;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_completed_items IS NULL OR p_completed_items < 0
     OR p_metadata IS NULL OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
     OR NOT private.is_valid_stats_sync_metadata(p_metadata - 'invalidMetadata', v_job_type) THEN
    RAISE EXCEPTION 'Stats sync failure checkpoint is invalid.';
  END IF;

  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  UPDATE public.sync_jobs
     SET status = 'failed',
         completed_items = p_completed_items,
         failed_items = failed_items + 1,
         error_log = CASE
           WHEN jsonb_array_length(COALESCE(error_log, '[]'::jsonb)) >= 100
             THEN (COALESCE(error_log, '[]'::jsonb) #- '{0}') || jsonb_build_array(left(COALESCE(p_error, 'Unknown stats sync failure'), 4000))
           ELSE COALESCE(error_log, '[]'::jsonb) || jsonb_build_array(left(COALESCE(p_error, 'Unknown stats sync failure'), 4000))
         END,
         metadata = p_metadata,
         completed_at = now(),
         claimed_at = NULL,
         claim_token = NULL
   WHERE id = p_job_id
     AND status = 'running'
     AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;
