CREATE OR REPLACE FUNCTION private.guard_player_career_games()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.career_games_base IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.career_regular_season_games IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF NEW.career_regular_season_games IS DISTINCT FROM OLD.career_regular_season_games
    OR (NEW.career_games_base,NEW.career_games_base_season) IS NOT DISTINCT FROM
       (OLD.career_games_base,OLD.career_games_base_season) THEN
    RETURN NEW;
  END IF;
  NEW.career_regular_season_games:=NEW.career_games_base+
    private.player_career_appearances(NEW.id,NEW.career_games_base_season);
  IF TG_OP='UPDATE' AND OLD.career_regular_season_games>=65 THEN
    NEW.career_regular_season_games:=greatest(OLD.career_regular_season_games,NEW.career_regular_season_games);
  END IF;
  RETURN NEW;
END;
$$;
