-- Canonical SQL source for private.season_year_after.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.season_year_after(p_season_year int, p_now timestamptz DEFAULT now())
RETURNS int
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT GREATEST(p_season_year + 1, public.current_season_year_et(p_now))
$$;
