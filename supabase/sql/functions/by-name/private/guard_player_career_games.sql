CREATE OR REPLACE FUNCTION private.guard_player_career_games()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_prior integer; v_games integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.career_regular_season_games IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF NEW.years_exp IS NOT DISTINCT FROM OLD.years_exp
    AND NEW.career_games_prior IS NOT DISTINCT FROM OLD.career_games_prior
    AND NEW.career_games_checked_at IS NOT DISTINCT FROM OLD.career_games_checked_at THEN
    RETURN NEW;
  END IF;
  SELECT prior,games INTO v_prior,v_games FROM private.player_career_values(NEW.id,NEW.years_exp,NEW.career_games_prior);
  NEW.career_games_prior := v_prior;
  NEW.career_regular_season_games := v_games;
  IF v_prior IS NOT NULL AND NEW.career_games_prior_checked_at IS NULL THEN NEW.career_games_prior_checked_at:=clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;
