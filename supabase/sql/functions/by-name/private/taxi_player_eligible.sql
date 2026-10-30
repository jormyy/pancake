-- Canonical SQL source for private.taxi_player_eligible.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.taxi_player_eligible(p_league_id uuid, p_player_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(player.years_exp = 0 OR player.career_regular_season_games < 65, false)
  FROM players player
  WHERE player.id = p_player_id;
$$;
