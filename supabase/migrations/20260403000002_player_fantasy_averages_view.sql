-- v_player_avg_fantasy_points
-- Aggregates avg fantasy points per player per league per season,
-- excluding DNP games. Used to sort the player search results by
-- league-specific fantasy value.
CREATE OR REPLACE VIEW v_player_avg_fantasy_points
  WITH (security_invoker = true)
AS
SELECT
  fp.league_id,
  fp.player_id,
  fp.season_year,
  ROUND(AVG(fp.fantasy_points)::numeric, 2) AS avg_fantasy_points
FROM v_fantasy_points fp
INNER JOIN player_game_stats pgs ON pgs.id = fp.stat_id AND NOT pgs.did_not_play
GROUP BY fp.league_id, fp.player_id, fp.season_year;

GRANT SELECT ON v_player_avg_fantasy_points TO authenticated, anon;
