CREATE OR REPLACE FUNCTION private.guard_player_career_games()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.career_games_base IS NOT NULL THEN
    NEW.career_regular_season_games:=NEW.career_games_base+
      private.player_career_appearances(NEW.id,NEW.career_games_base_season);
  ELSIF TG_OP='UPDATE' THEN
    NEW.career_regular_season_games:=greatest(OLD.career_regular_season_games,NEW.career_regular_season_games);
  END IF;
  RETURN NEW;
END;
$$;
