-- RPC: count Final games in a season that have no player_game_stats rows.
-- Used by the verify Edge Function to get accurate counts without PostgREST's 1000-row limit.
CREATE OR REPLACE FUNCTION count_final_games_missing_stats(season_year_param int)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(*)
  FROM nba_games g
  WHERE g.season_year = season_year_param
    AND g.status = 'Final'
    AND NOT EXISTS (
      SELECT 1 FROM player_game_stats s WHERE s.game_id = g.id
    );
$$;
