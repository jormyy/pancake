-- Canonical SQL source for private.assert_score_calendar.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_score_calendar(p_season_id uuid,p_week int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_year int; v_first int; v_last int; v_start date; v_end date;
BEGIN
  SELECT season_year INTO v_year FROM league_seasons WHERE id=p_season_id;
  PERFORM private.lock_nba_source(v_year,true);
  SELECT CASE WHEN bool_or(matchup_type='regular_season') THEN 1 ELSE p_week END,
    COALESCE(max(COALESCE(end_week_number,week_number)),p_week) INTO v_first,v_last
    FROM matchups WHERE league_season_id=p_season_id AND week_number=p_week;
  SELECT min(week_start),max(week_end) INTO v_start,v_end FROM season_weeks
    WHERE season_year=v_year AND week_number BETWEEN v_first AND v_last;
  IF EXISTS (
    SELECT 1 FROM nba_games game WHERE season_year=v_year
      AND (game.nba_game_id LIKE '002%' OR game.nba_game_id !~ '^00[0-9]')
      AND (game.week_number BETWEEN v_first AND v_last OR game.game_date BETWEEN v_start AND v_end)
      AND ((SELECT count(*) FROM season_weeks week WHERE week.season_year=v_year
        AND game.game_date BETWEEN week.week_start AND week.week_end)<>1 OR NOT EXISTS (
          SELECT 1 FROM season_weeks week WHERE week.season_year=v_year AND week.week_number=game.week_number
            AND game.game_date BETWEEN week.week_start AND week.week_end))
  ) THEN
    RAISE EXCEPTION 'Calendar resolution required: retained games do not match a unique scoring week. Existing results are preserved.' USING ERRCODE='55000';
  END IF;
END;
$$;
