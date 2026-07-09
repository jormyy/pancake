-- Canonical SQL source for public.leagues_seed_fantasy_avgs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.leagues_seed_fantasy_avgs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, analytics
AS $$
BEGIN
  PERFORM analytics.seed_league_fantasy_avgs(NEW.id);
  RETURN NEW;
END;
$$;
