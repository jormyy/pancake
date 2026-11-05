BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE history_fixture AS SELECT * FROM pg_temp.rules_fixture(5, 9400);
CREATE TEMP TABLE empty_history_fixture AS SELECT * FROM pg_temp.rules_fixture(2, 9401);
CREATE TEMP TABLE deep_history_fixture AS SELECT * FROM pg_temp.rules_fixture(16, 9402);
CREATE TEMP TABLE history_seasons(year int, id uuid);
GRANT SELECT ON history_fixture, empty_history_fixture, deep_history_fixture, history_seasons TO authenticated;

DO $$
DECLARE f record; season uuid; year int;
BEGIN
  SELECT * INTO f FROM history_fixture;
  FOR year IN 9398..9399 LOOP
    season := gen_random_uuid();
    INSERT INTO history_seasons VALUES(year, season);
    INSERT INTO public.league_seasons(id, league_id, season_year, is_current,
      playoff_start_week, playoff_round_weeks, playoff_seed_member_ids, playoff_bracket_seed_ids)
    VALUES(season, f.league_id, year, false, 3, ARRAY[1,1], f.member_ids[1:4], f.member_ids[1:4]);
    INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    SELECT year, week, make_date(year, 1, 1) + (week-1)*7, make_date(year, 1, 7) + (week-1)*7 FROM generate_series(1,4) week;
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id,
      home_points, away_points, winner_member_id, is_finalized, finalized_at)
    VALUES(f.league_id, season, 1, f.member_ids[1], f.member_ids[2], 120, 100, f.member_ids[1], true, now()),
      (f.league_id, season, 1, f.member_ids[3], f.member_ids[4], 90, 80, f.member_ids[3], true, now()),
      (f.league_id, season, 2, f.member_ids[1], f.member_ids[3], 100, 100, NULL, true, now()),
      (f.league_id, season, 2, f.member_ids[2], f.member_ids[5], 110, 80, f.member_ids[2], true, now());
    PERFORM private.rebuild_regular_standings(f.league_id, season);
    INSERT INTO public.matchups(league_id, league_season_id, week_number, end_week_number, matchup_type,
      playoff_round, playoff_position, home_member_id, away_member_id, home_points, away_points,
      winner_member_id, is_finalized, finalized_at)
    VALUES(f.league_id, season, 3, 3, 'playoff_semifinal', 1, 1, f.member_ids[1], f.member_ids[4], 80, 100, f.member_ids[4], true, now()),
      (f.league_id, season, 3, 3, 'playoff_semifinal', 1, 2, f.member_ids[2], f.member_ids[3], 80, 100, f.member_ids[3], true, now()),
      (f.league_id, season, 4, 4, 'playoff_final', 2, 1, f.member_ids[4], f.member_ids[3], CASE WHEN year = 9399 THEN 140 ELSE 130 END, CASE WHEN year = 9399 THEN 130 ELSE 140 END,
        CASE WHEN year = 9399 THEN f.member_ids[4] ELSE f.member_ids[3] END, true, now());
  END LOOP;
END;
$$;

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM deep_history_fixture;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
  SELECT 9402, week, date '9402-01-01' + (week-1)*7, date '9402-01-07' + (week-1)*7 FROM generate_series(1,6) week;
  UPDATE public.league_seasons SET playoff_round_weeks = ARRAY[1,1,1,1], playoff_start_week = 3,
    playoff_seed_member_ids = f.member_ids[1:4], playoff_bracket_seed_ids = f.member_ids WHERE id = f.season_id;
  INSERT INTO public.matchups(league_id, league_season_id, week_number, matchup_type, playoff_round, playoff_position,
    home_member_id, away_member_id, home_points, away_points, winner_member_id, is_finalized, finalized_at)
  VALUES(f.league_id, f.season_id, 3, 'playoff_quarterfinal', 1, 1, f.member_ids[1], f.member_ids[16], 100, 80, f.member_ids[1], true, now()),
    (f.league_id, f.season_id, 6, 'playoff_final', 4, 1, f.member_ids[1], f.member_ids[2], 100, 80, f.member_ids[1], true, now());
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; empty_f record; deep_f record; result jsonb; latest jsonb; rows jsonb;
BEGIN
  SELECT * INTO f FROM history_fixture;
  SELECT * INTO empty_f FROM empty_history_fixture;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[2]::text, true);
  result := public.view_league_history(f.league_id, f.member_ids[2]);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'seasons') = 2, 'members see both completed seasons and no current season');
  latest := result->'seasons'->0;
  rows := latest->'standings';
  PERFORM pg_temp.check_rules((latest->>'year')::int = 9399 AND (result->'seasons'->1->>'year')::int = 9398, 'seasons are newest first');
  PERFORM pg_temp.check_rules(latest->'champion'->>'memberId' = f.member_ids[4]::text, 'champion follows playoff result instead of regular season rank');
  PERFORM pg_temp.check_rules(result->'seasons'->1->'champion'->>'memberId' = f.member_ids[3]::text, 'each season has its own champion');
  PERFORM pg_temp.check_rules((SELECT array_agg(row->>'memberId' ORDER BY (row->>'finalRank')::int)
    FROM jsonb_array_elements(rows) row) = ARRAY[f.member_ids[4],f.member_ids[3],f.member_ids[1],f.member_ids[2],f.member_ids[5]]::text[],
    'final placements use playoff finish and regular season rank for equal round exits');
  PERFORM pg_temp.check_rules(rows->0->>'playoffResult' = 'Champion' AND rows->1->>'playoffResult' = 'Runner-up'
    AND rows->2->>'playoffResult' = 'Semifinal' AND rows->4->>'playoffResult' = 'Did not qualify', 'playoff finishes explain every placement');
  PERFORM pg_temp.check_rules(rows->2 @> '{"wins":1,"losses":0,"ties":1,"pointsFor":220,"pointsAgainst":200,"regularSeasonRank":1}',
    'regular season records and points exclude playoff games and earlier cumulative snapshots');
  PERFORM pg_temp.check_rules(latest->'stats' = '{"teams":5,"games":4,"pointsFor":780}'::jsonb, 'season stats include all regular season teams and games');
  PERFORM pg_temp.check_rules(public.view_league(f.league_id, f.member_ids[2], '{"tab":"seasons"}')->'seasons' = result->'seasons', 'league screen reads the same history');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_league_history(%L,%L)', f.league_id, f.member_ids[1]),
    'This screen is not available.', 'members cannot impersonate another manager');
  PERFORM set_config('request.jwt.claim.sub', empty_f.user_ids[1]::text, true);
  PERFORM pg_temp.check_rules(public.view_league_history(empty_f.league_id, empty_f.member_ids[1])->'seasons' = '[]'::jsonb, 'league without completed seasons returns an empty list');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_league_history(%L,%L)', f.league_id, f.member_ids[2]),
    'This screen is not available.', 'non-members cannot read history');
  SELECT * INTO deep_f FROM deep_history_fixture;
  PERFORM set_config('request.jwt.claim.sub', deep_f.user_ids[1]::text, true);
  PERFORM pg_temp.check_rules((SELECT row->>'playoffResult' = 'Round 1'
    FROM jsonb_array_elements(public.view_league_history(deep_f.league_id, deep_f.member_ids[1])->'seasons'->0->'standings') row
    WHERE row->>'memberId' = deep_f.member_ids[16]::text), 'large brackets label early exits by their actual round');
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_temp.reject_rules(format('SELECT public.view_league_history(%L,%L)', f.league_id, f.member_ids[2]),
    'This screen is not available.', 'unsigned requests cannot read history');
END;
$$;
RESET ROLE;
SELECT pg_temp.check_rules(NOT has_function_privilege('anon', 'public.view_league_history(uuid,uuid,jsonb)', 'EXECUTE'), 'anonymous role has no history grant');
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
