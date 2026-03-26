-- Remove preseason games (nba_game_id starts with '001')
-- These were incorrectly included and skew week number calculations
DELETE FROM nba_games WHERE nba_game_id LIKE '001%';
