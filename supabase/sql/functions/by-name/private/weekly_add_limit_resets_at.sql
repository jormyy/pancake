-- Canonical SQL source for private.weekly_add_limit_resets_at.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.weekly_add_limit_resets_at(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT week.resets_at
    FROM private.current_add_week(p_league_id, p_league_season_id) AS week
$$;
