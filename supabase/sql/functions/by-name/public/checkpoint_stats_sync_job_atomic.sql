-- Canonical SQL source for public.checkpoint_stats_sync_job_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.checkpoint_stats_sync_job_atomic(
  p_job_id uuid,
  p_claim_token uuid,
  p_completed_items integer,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_completed_items < 0 OR jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Stats sync checkpoint is invalid.';
  END IF;

  PERFORM set_config('app.stats_sync_fenced_transition', 'on', true);
  UPDATE public.sync_jobs
     SET completed_items = p_completed_items,
         metadata = p_metadata,
         claimed_at = now()
   WHERE id = p_job_id
     AND status = 'running'
     AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;
