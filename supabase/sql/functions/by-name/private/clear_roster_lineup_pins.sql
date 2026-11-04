-- Canonical SQL source for private.clear_roster_lineup_pins.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.clear_roster_lineup_pins()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = OLD.league_id AND league_season_id = OLD.league_season_id
      AND member_id = OLD.member_id AND player_id = OLD.player_id;
    RETURN OLD;
  END IF;
  IF (OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id)
    IS DISTINCT FROM (NEW.league_id, NEW.league_season_id, NEW.member_id, NEW.player_id) THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = OLD.league_id AND league_season_id = OLD.league_season_id
      AND member_id = OLD.member_id AND player_id = OLD.player_id;
  END IF;
  IF (NEW.is_on_ir AND NOT OLD.is_on_ir) OR (NEW.is_on_taxi AND NOT OLD.is_on_taxi) THEN
    DELETE FROM public.lineup_player_pins WHERE league_id = NEW.league_id AND league_season_id = NEW.league_season_id
      AND member_id = NEW.member_id AND player_id = NEW.player_id
      AND game_date >= (SELECT (now() AT TIME ZONE COALESCE(timezone, 'America/Los_Angeles'))::date
        FROM public.leagues WHERE id = NEW.league_id);
  END IF;
  RETURN NEW;
END;
$$;
