-- Canonical SQL source for public.count_final_games_missing_stats.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION count_final_games_missing_stats(season_year_param int)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)
  FROM nba_games g
  WHERE g.season_year = season_year_param
    AND g.status = 'Final'
    AND NOT EXISTS (
      SELECT 1 FROM player_game_stats s WHERE s.game_id = g.id
    );
$$;
