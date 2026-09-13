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
SET search_path = public
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  -- One dispatch per (job, period). The first tick at or after the target time
  -- wins; every later tick in the same period is a no-op. A late tick still
  -- fires, and where the schedule has a later tick in the period it catches a
  -- missed one up without double-dispatching. The claim rides on the caller's
  -- transaction: a synchronous raise in the invoke rolls it back.
  INSERT INTO public.cron_dispatch_state (job_key, period_key, dispatched_at)
  VALUES (p_job_key, p_period_key, now())
  ON CONFLICT (job_key) DO UPDATE
     SET period_key = EXCLUDED.period_key,
         dispatched_at = EXCLUDED.dispatched_at
   WHERE public.cron_dispatch_state.period_key <> EXCLUDED.period_key
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;
