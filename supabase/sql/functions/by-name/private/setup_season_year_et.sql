-- Canonical SQL source for private.setup_season_year_et.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.setup_season_year_et(p_now timestamptz DEFAULT now())
RETURNS int
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  -- current_season_year_et() flips on Oct 1 ET. A league set up after the
  -- current season's last week has ended plays the next season instead.
  SELECT CASE
    WHEN (
      SELECT max(week.week_end)
        FROM public.season_weeks AS week
       WHERE week.season_year = calendar.season_year
    ) < timezone('America/New_York', p_now)::date
      THEN calendar.season_year + 1
    ELSE calendar.season_year
  END
    FROM (SELECT public.current_season_year_et(p_now) AS season_year) AS calendar;
$$;
