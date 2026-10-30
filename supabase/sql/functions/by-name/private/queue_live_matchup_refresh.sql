-- Canonical SQL source for private.queue_live_matchup_refresh.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.queue_live_matchup_refresh()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.is_voided OR TG_OP='UPDATE' AND
    ROW(NEW.home_points,NEW.away_points,NEW.home_max_possible_points,NEW.away_max_possible_points)
      IS NOT DISTINCT FROM ROW(OLD.home_points,OLD.away_points,OLD.home_max_possible_points,OLD.away_max_possible_points) THEN
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.league_seasons season
    JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=NEW.week_number
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(NEW.end_week_number,NEW.week_number)
    WHERE season.id=NEW.league_season_id AND season.is_current
      AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN first_week.week_start AND last_week.week_end
      AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
        AND game.game_date=(now() AT TIME ZONE 'America/New_York')::date
        AND game.status IN('InProgress','Final') AND public.is_regular_season_game_id(game.nba_game_id))) THEN
    INSERT INTO private.live_matchup_refresh_queue AS queued(matchup_id) VALUES(NEW.id)
      ON CONFLICT(matchup_id) DO UPDATE SET revision=EXCLUDED.revision;
  END IF;
  RETURN NEW;
END;
$$;
