-- Canonical SQL source for public.current_season_year_et.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.current_season_year_et(
  p_now timestamptz DEFAULT now()
)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN extract(month FROM timezone('America/New_York', p_now)) >= 10
      THEN extract(year FROM timezone('America/New_York', p_now))::int + 1
    ELSE extract(year FROM timezone('America/New_York', p_now))::int
  END
$$;
