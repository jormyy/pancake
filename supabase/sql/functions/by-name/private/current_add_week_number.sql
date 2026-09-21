-- Canonical SQL source for private.current_add_week_number.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.current_add_week_number(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT week.week_number
    FROM private.current_add_week(p_league_id, p_league_season_id) AS week
$$;
