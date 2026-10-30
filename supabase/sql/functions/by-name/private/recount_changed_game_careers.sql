-- Canonical SQL source for private.recount_changed_game_careers.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.recount_changed_game_careers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.nba_game_id,NEW.season_year,NEW.game_date) IS DISTINCT FROM (OLD.nba_game_id,OLD.season_year,OLD.game_date) THEN
    PERFORM private.recount_player_career_games(ARRAY(SELECT player_id FROM public.player_game_stats WHERE game_id=NEW.id));
  END IF;
  RETURN NULL;
END;
$$;
