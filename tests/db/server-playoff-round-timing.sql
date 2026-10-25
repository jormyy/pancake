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
  f record;
  result jsonb;
  span int;
  scenario int;
  fixture_year int;
  last_date date;
BEGIN
  FOR scenario IN 1..3 LOOP
    span := LEAST(scenario, 2);
    fixture_year := 9495 + scenario;
    SELECT * INTO f FROM pg_temp.rules_fixture(4, fixture_year, 'playoffs');
    INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    SELECT fixture_year, week, date '2026-04-06' + (week - 1) * 7, date '2026-04-12' + (week - 1) * 7
    FROM generate_series(1, span + 1) week;
    UPDATE public.leagues SET playoff_start_week = 1, playoff_entrants = 4, playoff_round_lengths = ARRAY[span, 1], playoff_total_weeks = span + 1, playoff_round_weeks = ARRAY[span, 1]
    WHERE id = f.league_id;
    UPDATE public.league_seasons SET playoff_start_week = 1, playoff_round_weeks = ARRAY[span, 1]
    WHERE id = f.season_id;
    last_date := date '2026-04-12' + CASE WHEN scenario = 3 THEN 0 ELSE (span - 1) * 7 END;
    INSERT INTO public.nba_games(nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES('002949500' || scenario, fixture_year, CASE WHEN scenario = 3 THEN 1 ELSE span END, last_date, 'RTA', 'RTB', 'Final');
    PERFORM public.generate_playoff_bracket_atomic(f.league_id);
    UPDATE public.matchups SET is_finalized = true, winner_member_id = home_member_id,
      home_points = 10, away_points = 5 WHERE league_season_id = f.season_id;
    PERFORM pg_temp.certify_rules_week(f.league_id, f.season_id, 1);
    UPDATE public.matchups SET finalized_at = ((last_date + 1)::timestamp + interval '19 hours 10 minutes') AT TIME ZONE 'America/New_York'
    WHERE league_season_id = f.season_id;
    IF scenario = 3 THEN
      result := public.apply_season_boundary_after_grace(p_league_id => f.league_id, p_league_season_id => f.season_id,
        p_action => 'advance', p_reference_at => timestamptz '2026-04-20 20:00 America/New_York');
      PERFORM pg_temp.check_rules(result->>'applied' = 'true', 'an empty final week uses the last game across the whole round');
      CONTINUE;
    END IF;
    result := public.apply_season_boundary_after_grace(p_league_id => f.league_id, p_league_season_id => f.season_id,
      p_action => 'advance', p_reference_at => ((last_date + 1)::timestamp + interval '20 hours') AT TIME ZONE 'America/New_York');
    PERFORM pg_temp.check_rules(result->>'applied' = 'false', 'round waits through Monday for span ' || span);
    result := public.apply_season_boundary_after_grace(p_league_id => f.league_id, p_league_season_id => f.season_id,
      p_action => 'advance', p_reference_at => ((last_date + 2)::timestamp + interval '9 hours') AT TIME ZONE 'America/New_York');
    PERFORM pg_temp.check_rules(result->>'applied' = 'true', 'Monday 19:10 finalization advances Tuesday 09:00 for span ' || span);
    PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.matchups WHERE league_season_id = f.season_id
      AND matchup_type = 'playoff_final'), 'next round exists for span ' || span);
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
