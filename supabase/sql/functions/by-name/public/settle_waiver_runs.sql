-- Canonical SQL source for public.settle_waiver_runs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.settle_waiver_runs(p_timezone text, p_date date, p_drain_started_at timestamptz)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.settle_waiver_runs(p_timezone, p_date, p_drain_started_at);
$$;
