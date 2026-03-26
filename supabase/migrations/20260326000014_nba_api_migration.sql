-- Add new ID columns for NBA CDN + Sleeper API migration
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS sleeper_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS nba_id TEXT UNIQUE;

ALTER TABLE nba_games
    ADD COLUMN IF NOT EXISTS nba_game_id TEXT UNIQUE;
