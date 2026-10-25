-- Canonical SQL source for public.set_waiver_clears_at.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION set_waiver_clears_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_eligible_at timestamptz := NEW.placed_on_waivers_at + interval '48 hours';
  v_run_at timestamp;
BEGIN
  v_run_at := date_trunc('day', v_eligible_at AT TIME ZONE 'America/New_York') + interval '3 hours';
  IF v_run_at AT TIME ZONE 'America/New_York' < v_eligible_at THEN
    v_run_at := v_run_at + interval '1 day';
  END IF;
  NEW.clears_at := v_run_at AT TIME ZONE 'America/New_York';
  RETURN NEW;
END;
$$;
