BEGIN;
\ir rules-support.sql

CREATE FUNCTION pg_temp.certify_rules_week(p_league uuid, p_season uuid, p_week int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_token jsonb;
  v_payload jsonb;
BEGIN
  v_token := public.capture_score_inputs(p_season, p_week);
  SELECT jsonb_agg(jsonb_build_object('id', id, 'winner_member_id', winner_member_id,
    'home_points', home_points, 'away_points', away_points,
    'home_max_possible_points', home_max_possible_points, 'away_max_possible_points', away_max_possible_points,
    'input_token', v_token)) INTO v_payload
  FROM public.matchups WHERE league_season_id = p_season AND week_number = p_week;
  PERFORM public.finalize_score_week_atomic(p_league, p_season, p_week, v_payload, '[]');
END;
$$;

DO $$
DECLARE
  v_fixture record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_fixture FROM pg_temp.rules_fixture(4, 9377);
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
  SELECT 9377, week, date '9377-02-01' + (week - 1) * 7, date '9377-02-07' + (week - 1) * 7
  FROM generate_series(1, 3) week;
  UPDATE public.leagues SET playoff_start_week = 2 WHERE id = v_fixture.league_id;
  INSERT INTO public.nba_games(nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
  VALUES('rules-correction-window-1', 9377, 1, '9377-02-06', 'RCA', 'RCB', 'Final'),
    ('0019377001', 9377, 1, '9377-02-07', 'RCC', 'RCD', 'Final'),
    ('rules-correction-window-playoffs', 9377, 2, '9377-02-09', 'RCA', 'RCB', 'Final');
  INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id,
    matchup_type, home_points, away_points, is_finalized, winner_member_id, finalized_at)
  SELECT v_fixture.league_id, v_fixture.season_id, 1, v_fixture.member_ids[side], v_fixture.member_ids[5 - side],
    'regular_season', 10, 5, true, v_fixture.member_ids[side], timestamptz '9377-02-07 00:00 America/New_York'
  FROM generate_series(1, 2) side;
  PERFORM pg_temp.certify_rules_week(v_fixture.league_id, v_fixture.season_id, 1);
  v_result := public.apply_season_boundary_after_grace(v_fixture.league_id, v_fixture.season_id,
    'generate', timestamptz '9377-02-07 00:00 America/New_York');
  PERFORM pg_temp.check_rules(v_result->>'applied' = 'false', 'the final game date stays inside the correction window');
  v_result := public.apply_season_boundary_after_grace(v_fixture.league_id, v_fixture.season_id,
    'generate', timestamptz '9377-02-07 23:59:59 America/New_York');
  PERFORM pg_temp.check_rules(v_result->>'applied' = 'false', 'the final game date waits through midnight');
  UPDATE public.matchups SET finalized_at = timestamptz '9377-02-07 23:59 America/New_York'
  WHERE league_season_id = v_fixture.season_id;
  PERFORM pg_temp.certify_rules_week(v_fixture.league_id, v_fixture.season_id, 1);
  v_result := public.apply_season_boundary_after_grace(v_fixture.league_id, v_fixture.season_id,
    'generate', timestamptz '9377-02-08 00:00 America/New_York');
  PERFORM pg_temp.check_rules(v_result->>'applied' = 'true', 'the next ET date unlocks seeds despite recent scoring');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.matchups WHERE league_season_id = v_fixture.season_id
    AND matchup_type <> 'regular_season'), 'correction window creates the bracket once');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
