-- Add scheduled tip-off time to nba_games so lineup locking can use
-- scheduled game_time instead of relying solely on the live status field.
-- This eliminates the 30–60s polling window where a game has started but
-- the DB status hasn't been updated yet.
ALTER TABLE nba_games ADD COLUMN IF NOT EXISTS game_time timestamptz;
CREATE INDEX IF NOT EXISTS idx_nba_games_game_time ON nba_games(game_time);
