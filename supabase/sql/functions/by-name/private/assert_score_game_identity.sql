-- Canonical SQL source for private.assert_score_game_identity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_score_game_identity(p_season_id uuid,p_week int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_year int; v_first int; v_last int; v_start date; v_end date; v_game record;
BEGIN
  SELECT season_year INTO v_year FROM public.league_seasons WHERE id=p_season_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League season not found.' USING ERRCODE='22023'; END IF;
  PERFORM private.lock_nba_source(v_year,true);
  PERFORM private.assert_score_calendar(p_season_id,p_week);
  SELECT CASE WHEN bool_or(matchup_type='regular_season') THEN 1 ELSE p_week END,
    COALESCE(max(COALESCE(end_week_number,week_number)),p_week) INTO v_first,v_last
    FROM public.matchups WHERE league_season_id=p_season_id AND week_number=p_week;
  SELECT min(week_start),max(week_end) INTO v_start,v_end FROM public.season_weeks
    WHERE season_year=v_year AND week_number BETWEEN v_first AND v_last;
  FOR v_game IN SELECT * FROM public.nba_games WHERE season_year=v_year
    AND (week_number BETWEEN v_first AND v_last OR game_date BETWEEN v_start AND v_end) LOOP
    PERFORM private.assert_nba_game_candidate(v_game.nba_game_id,v_game.season_year,v_game.game_date,v_game.home_team,v_game.away_team,v_game.id);
  END LOOP;
END;
$$;
