-- Add dynasty ranking to players table.
-- Sourced from hashtagbasketball.com, synced via backend scraper.
-- NULL means the player isn't ranked (rookies, G-League, etc.)

ALTER TABLE players ADD COLUMN IF NOT EXISTS dynasty_rank integer;

CREATE INDEX IF NOT EXISTS idx_players_dynasty_rank ON players (dynasty_rank)
  WHERE dynasty_rank IS NOT NULL;
