-- Canonical SQL source for public.claim_lineup_tipoff_dispatch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.claim_lineup_tipoff_dispatch(p_tipoff_at timestamptz, p_token uuid)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date date;
BEGIN
  UPDATE public.lineup_tipoff_dispatches
     SET status = 'running', lease_until = now() + interval '45 seconds'
   WHERE tipoff_at = p_tipoff_at AND token = p_token AND status = 'queued'
     AND lease_until > clock_timestamp()
     AND game_date = (now() AT TIME ZONE 'America/New_York')::date
     AND tipoff_at > now() - interval '1 minute'
  RETURNING game_date INTO v_date;
  RETURN v_date;
END;
$$;
