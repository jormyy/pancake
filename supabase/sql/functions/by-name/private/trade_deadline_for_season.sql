-- Canonical SQL source for private.trade_deadline_for_season.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_deadline_for_season(
  p_deadline date,
  p_season_year int
)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  -- A league's trade deadline is a month and day that repeats every season.
  -- Season N runs from October of N-1 through September of N, matching
  -- current_season_year_et(). Feb 29 falls back to Feb 28 in other years.
  SELECT (
    anchor.month_start
    + least(
        extract(day FROM p_deadline)::int,
        extract(day FROM anchor.month_start + interval '1 month - 1 day')::int
      )
    - 1
  )
    FROM (
      SELECT make_date(
        CASE WHEN extract(month FROM p_deadline) >= 10 THEN p_season_year - 1 ELSE p_season_year END,
        extract(month FROM p_deadline)::int,
        1
      ) AS month_start
    ) AS anchor
   WHERE p_deadline IS NOT NULL
     AND p_season_year IS NOT NULL;
$$;
