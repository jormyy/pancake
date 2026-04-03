-- Remove All-Star games (nba_game_id starts with '003')
-- These are exhibition games and should not count toward regular season stats.
-- Same pattern as 20260326000015_remove_preseason_games.sql ('001%').

-- Must delete player_game_stats first (no CASCADE on the FK)
DELETE FROM player_game_stats
WHERE game_id IN (
    SELECT id FROM nba_games WHERE nba_game_id LIKE '003%'
);

DELETE FROM nba_games WHERE nba_game_id LIKE '003%';

-- Refresh the materialized view so averages are immediately corrected
REFRESH MATERIALIZED VIEW mv_player_season_averages;
