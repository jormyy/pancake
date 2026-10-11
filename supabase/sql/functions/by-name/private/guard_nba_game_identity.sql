CREATE OR REPLACE FUNCTION private.guard_nba_game_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.nba_game_id,NEW.season_year,NEW.game_date,NEW.home_team,NEW.away_team)
       IS NOT DISTINCT FROM ROW(OLD.nba_game_id,OLD.season_year,OLD.game_date,OLD.home_team,OLD.away_team) THEN RETURN NEW; END IF;
    PERFORM private.lock_nba_source(LEAST(OLD.season_year,NEW.season_year));
    PERFORM private.lock_nba_source(GREATEST(OLD.season_year,NEW.season_year));
    IF NEW.nba_game_id IS DISTINCT FROM OLD.nba_game_id AND
       private.nba_game_provider(NEW.nba_game_id)<>private.nba_game_provider(OLD.nba_game_id) THEN
      RAISE EXCEPTION 'Cannot replace a game provider identity without verified mapping.' USING ERRCODE='55000';
    END IF;
  ELSE
    -- An upsert of an existing game becomes an update, whose path guards identity changes.
    IF EXISTS (SELECT 1 FROM public.nba_games WHERE id=NEW.id) THEN RETURN NEW; END IF;
    PERFORM private.lock_nba_source(NEW.season_year);
  END IF;
  PERFORM private.assert_nba_game_candidate(NEW.nba_game_id,NEW.season_year,NEW.game_date,NEW.home_team,NEW.away_team,NEW.id);
  RETURN NEW;
END;
$$;
