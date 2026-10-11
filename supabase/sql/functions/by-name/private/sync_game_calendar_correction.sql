-- Canonical SQL source for private.sync_game_calendar_correction.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.sync_game_calendar_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM player_game_stats WHERE game_id = NEW.id) THEN
    INSERT INTO game_calendar_corrections(game_id, season_year, game_date, updated_at)
    SELECT DISTINCT NEW.id, calendar.season_year, calendar.game_date, now()
      FROM (VALUES(OLD.season_year, OLD.game_date),
                  (NEW.season_year, NEW.game_date)) AS calendar(season_year, game_date)
    ON CONFLICT(game_id, season_year, game_date)
    DO UPDATE SET updated_at = EXCLUDED.updated_at;

    UPDATE player_game_stats
       SET game_date = NEW.game_date, season_year = NEW.season_year,
           week_number = NEW.week_number, updated_at = now()
     WHERE game_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
