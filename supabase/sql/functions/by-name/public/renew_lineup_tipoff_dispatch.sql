-- Canonical SQL source for public.renew_lineup_tipoff_dispatch.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.renew_lineup_tipoff_dispatch(p_tipoff_at timestamptz,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.lineup_tipoff_dispatches SET lease_until=clock_timestamp()+interval '45 seconds'
  WHERE tipoff_at=p_tipoff_at AND token=p_token AND status='running' AND lease_until>clock_timestamp()
    AND game_date=(clock_timestamp() AT TIME ZONE 'America/New_York')::date
    AND tipoff_at>clock_timestamp()-interval '1 minute';
  RETURN FOUND;
END;
$$;
