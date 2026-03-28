-- sportsdata.io is no longer used as a data source.
-- Make sportsdata_game_id nullable so NBA CDN-sourced games can be inserted without it.
ALTER TABLE nba_games
    ALTER COLUMN sportsdata_game_id DROP NOT NULL;

ALTER TABLE players
    ALTER COLUMN sportsdata_id DROP NOT NULL;
