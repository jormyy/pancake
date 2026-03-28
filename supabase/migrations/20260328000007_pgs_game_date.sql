-- ============================================================
-- Migration: Denormalize game_date onto player_game_stats
--
-- Ordering player_game_stats by nba_games.game_date via a
-- foreign-table reference in PostgREST is unreliable when
-- combined with LIMIT/OFFSET (sort happens after slicing).
-- Adding game_date directly allows ORDER BY game_date DESC
-- without a join and fixes pagination ordering.
-- ============================================================

ALTER TABLE player_game_stats
  ADD COLUMN IF NOT EXISTS game_date date;

-- Backfill existing rows
UPDATE player_game_stats pgs
SET    game_date = g.game_date
FROM   nba_games g
WHERE  g.id = pgs.game_id
  AND  pgs.game_date IS NULL;

-- Keep in sync on INSERT
CREATE OR REPLACE FUNCTION set_pgs_game_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT game_date INTO NEW.game_date FROM nba_games WHERE id = NEW.game_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pgs_game_date
  BEFORE INSERT ON player_game_stats
  FOR EACH ROW EXECUTE FUNCTION set_pgs_game_date();

CREATE INDEX IF NOT EXISTS idx_pgs_game_date
  ON player_game_stats(player_id, season_year, game_date DESC);
