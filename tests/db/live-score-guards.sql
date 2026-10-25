\set ON_ERROR_STOP on
\getenv live_test_api_url SUPABASE_URL
\getenv live_test_db_url SUPABASE_DB_URL
\getenv live_test_api_port PANCAKE_TEST_API_PORT
\getenv live_test_db_port PANCAKE_TEST_DB_PORT
\if :{?live_test_api_url}
\else
  \echo SUPABASE_URL is required
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
\if :{?live_test_db_url}
\else
  \echo SUPABASE_DB_URL is required
  DO $$ BEGIN RAISE EXCEPTION 'Database test configuration is missing or invalid.'; END $$;
\endif
\if :{?live_test_api_port}
\else
  \set live_test_api_port 54321
\endif
\if :{?live_test_db_port}
\else
  \set live_test_db_port 54322
\endif
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
SELECT set_config('app.supabase_url', :'live_test_api_url', true);
SELECT set_config('live.test_api_port', :'live_test_api_port', true) \gset
SELECT set_config('live.test_db_url', :'live_test_db_url', true) \gset
SELECT set_config('live.test_db_port', :'live_test_db_port', true) \gset
DO $$
DECLARE
  v_year int;
  v_users uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_regular uuid := gen_random_uuid();
  v_closed uuid := gen_random_uuid();
  v_consumed uuid := gen_random_uuid();
  v_row text;
BEGIN
  IF current_setting('live.test_api_port') !~ '^[0-9]+$' OR current_setting('live.test_db_port') !~ '^[0-9]+$'
    OR current_setting('app.supabase_url') !~ format('^https?://(127[.]0[.]0[.]1|localhost):%s/?$', current_setting('live.test_api_port'))
    OR current_setting('live.test_db_url') !~ format('^postgres(ql)?://([^/@]+@)?(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$', current_setting('live.test_db_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback API and database ports are allowed';
  END IF;
  SELECT candidate.year INTO v_year FROM generate_series(9395, 9495) AS candidate(year)
    WHERE NOT EXISTS (SELECT 1 FROM season_weeks WHERE season_year = candidate.year)
      AND NOT EXISTS (SELECT 1 FROM league_seasons WHERE season_year = candidate.year)
      AND NOT EXISTS (SELECT 1 FROM nba_games WHERE season_year = candidate.year)
    ORDER BY candidate.year LIMIT 1;
  IF v_year IS NULL THEN RAISE EXCEPTION 'No unused fixture season year'; END IF;
  FOR side IN 1..2 LOOP
    INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
      VALUES(v_users[side], 'authenticated', 'authenticated', v_users[side] || '@example.test', '{}', '{}');
  END LOOP;
  INSERT INTO leagues(id, name, slug, commissioner_id, status)
    VALUES(v_league, 'Synthetic score guards', v_league::text, v_users[1], 'active');
  INSERT INTO league_seasons(id, league_id, season_year, is_current) VALUES(v_season, v_league, v_year, true);
  FOR side IN 1..2 LOOP
    INSERT INTO league_members(id, league_id, user_id, role, team_name)
      VALUES(v_members[side], v_league, v_users[side], CASE WHEN side = 1 THEN 'commissioner' ELSE 'manager' END::league_member_role, 'Team ' || side);
  END LOOP;
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    SELECT v_year, week, date '2099-01-01' + (week - 1) * 7, date '2099-01-07' + (week - 1) * 7 FROM generate_series(1, 4) week;
  INSERT INTO matchups(id, league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type,
    is_finalized, finalized_at, home_points, away_points)
    VALUES(v_regular, v_league, v_season, 1, v_members[1], v_members[2], 'regular_season', false, NULL, 10, 20),
      (v_closed, v_league, v_season, 2, v_members[1], v_members[2], 'playoff_semifinal', true, now(), 10, 20);
  SELECT ctid::text INTO v_row FROM matchups WHERE id = v_regular;
  IF update_score_points_atomic(v_league, v_season, 1,
    jsonb_build_array(jsonb_build_object('id', v_regular, 'home_points', 10, 'away_points', 20))) <> 0
    OR (SELECT ctid::text FROM matchups WHERE id = v_regular) <> v_row THEN
    RAISE EXCEPTION 'Identical points write emits an update';
  END IF;
  IF update_score_points_atomic(v_league, v_season, 1,
    jsonb_build_array(jsonb_build_object('id', v_regular, 'home_points', 11, 'away_points', 19))) <> 1 THEN
    RAISE EXCEPTION 'Changed live points do not update';
  END IF;
  IF update_score_points_atomic(v_league, v_season, 2,
    jsonb_build_array(jsonb_build_object('id', v_closed, 'home_points', 99, 'away_points', 0))) <> 0
    OR (SELECT home_points FROM matchups WHERE id = v_closed) <> 10 THEN
    RAISE EXCEPTION 'Late live score overwrites finalized playoff points';
  END IF;
  INSERT INTO matchups(id, league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type,
    is_finalized, home_points, away_points)
    VALUES(v_consumed, v_league, v_season, 3, v_members[1], v_members[2], 'playoff_quarterfinal', false, 10, 20);
  IF NOT private.playoff_matchup_is_consumed(v_consumed) THEN RAISE EXCEPTION 'Consumed control has no consumer'; END IF;
  IF update_score_points_atomic(v_league, v_season, 3,
    jsonb_build_array(jsonb_build_object('id', v_consumed, 'home_points', 99, 'away_points', 0))) <> 0
    OR (SELECT home_points FROM matchups WHERE id = v_consumed) <> 10 THEN
    RAISE EXCEPTION 'Late live score overwrites a consumed round';
  END IF;
END;
$$;
ROLLBACK;
SELECT 'live score write guards: PASS';
