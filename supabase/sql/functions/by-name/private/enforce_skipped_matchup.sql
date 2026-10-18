CREATE OR REPLACE FUNCTION private.enforce_skipped_matchup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.matchup_type = 'regular_season' AND EXISTS (SELECT 1 FROM league_seasons
    WHERE id = NEW.league_season_id AND NEW.week_number = ANY(skipped_weeks)) THEN
    NEW.is_voided := true;
    NEW.is_finalized := false;
    NEW.winner_member_id := NULL;
    NEW.home_points := 0;
    NEW.away_points := 0;
    NEW.home_max_possible_points := NULL;
    NEW.away_max_possible_points := NULL;
    NEW.finalized_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
