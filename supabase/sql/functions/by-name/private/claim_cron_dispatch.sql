-- Canonical SQL source for private.claim_cron_dispatch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.claim_cron_dispatch(
  p_job_key text,
  p_period_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  INSERT INTO public.cron_dispatch_state (job_key, period_key, dispatched_at)
  VALUES (p_job_key, p_period_key, clock_timestamp())
  ON CONFLICT (job_key) DO UPDATE
     SET period_key = EXCLUDED.period_key,
         dispatched_at = EXCLUDED.dispatched_at,
         attempts = CASE WHEN cron_dispatch_state.period_key = EXCLUDED.period_key
           THEN cron_dispatch_state.attempts + 1 ELSE 1 END,
         retry_after = NULL
   WHERE cron_dispatch_state.period_key <> EXCLUDED.period_key
      OR (cron_dispatch_state.retry_after <= clock_timestamp() AND cron_dispatch_state.attempts < 3)
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;
