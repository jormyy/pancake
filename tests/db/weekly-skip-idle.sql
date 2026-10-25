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
SELECT set_config('app.edge_internal_token', 'local-database-ci-token', true);
DO $$
DECLARE
  v_invocation_floor bigint;
  v_year int;
  v_users uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_start date := date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 14;
  v_before int;
BEGIN
  IF current_setting('live.test_api_port') !~ '^[0-9]+$' OR current_setting('live.test_db_port') !~ '^[0-9]+$'
    OR current_setting('app.supabase_url') !~ format('^https?://(127[.]0[.]0[.]1|localhost):%s/?$', current_setting('live.test_api_port'))
    OR current_setting('live.test_db_url') !~ format('^postgres(ql)?://([^/@]+@)?(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$', current_setting('live.test_db_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback API and database ports are allowed';
  END IF;
  SELECT COALESCE(max(id), 0) INTO v_invocation_floor FROM edge_invocations;
  UPDATE leagues SET status = 'archived' WHERE status IN ('active', 'playoffs');
  UPDATE live_poll_leases SET expires_at = clock_timestamp() - interval '1 second'
    WHERE lock_key = 779001 AND expires_at > clock_timestamp();
  UPDATE nba_games SET status = 'Final', stats_synced_at = clock_timestamp()
    WHERE id IN (SELECT id FROM get_live_poll_work());
  UPDATE edge_invocations SET queued_at = clock_timestamp() - interval '31 minutes'
    WHERE function_name = 'sync-scores' AND queued_at > clock_timestamp() - interval '30 minutes';
  IF EXISTS (SELECT 1 FROM get_live_poll_work()) THEN RAISE EXCEPTION 'Fixture isolation leaves live work'; END IF;
  SELECT candidate.year INTO v_year FROM generate_series(9599, 9699) AS candidate(year)
    WHERE NOT EXISTS (SELECT 1 FROM season_weeks WHERE season_year = candidate.year)
      AND NOT EXISTS (SELECT 1 FROM league_seasons WHERE season_year = candidate.year)
      AND NOT EXISTS (SELECT 1 FROM nba_games WHERE season_year = candidate.year)
    ORDER BY candidate.year LIMIT 1;
  IF v_year IS NULL THEN RAISE EXCEPTION 'No unused fixture season year'; END IF;

  FOR side IN 1..2 LOOP
    INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
      VALUES(v_users[side], 'authenticated', 'authenticated', v_users[side] || '@example.test', '{}', '{}');
  END LOOP;
  INSERT INTO leagues(id, name, slug, commissioner_id, status, playoff_start_week)
    VALUES(v_league, 'Synthetic skipped-week gate', v_league::text, v_users[1], 'active', 20);
  INSERT INTO league_seasons(id, league_id, season_year, is_current) VALUES(v_season, v_league, v_year, true);
  FOR side IN 1..2 LOOP
    INSERT INTO league_members(id, league_id, user_id, role, team_name)
      VALUES(v_members[side], v_league, v_users[side], CASE WHEN side = 1 THEN 'commissioner' ELSE 'manager' END::league_member_role, 'Side ' || side);
  END LOOP;
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    VALUES(v_year, 1, v_start, v_start + 6), (v_year, 2, v_start + 7, v_start + 13);
  INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type)
    VALUES(v_league, v_season, 1, v_members[1], v_members[2], 'regular_season');
  PERFORM set_config('request.jwt.claim.sub', v_users[1]::text, true);
  PERFORM update_league_settings_atomic(v_league, '{"skipped_weeks":[1]}'::jsonb);
  IF (SELECT skipped_weeks FROM league_seasons WHERE id = v_season) IS DISTINCT FROM ARRAY[1] THEN
    RAISE EXCEPTION 'Real settings path did not skip week one';
  END IF;
  SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_before THEN
    RAISE EXCEPTION 'Skipped opening week wakes idle scoring';
  END IF;
  INSERT INTO matchups(league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type)
    VALUES(v_league, v_season, 2, v_members[1], v_members[2], 'regular_season');
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_before + 1 THEN
    RAISE EXCEPTION 'First eligible week does not wake idle scoring';
  END IF;
END;
$$;
ROLLBACK;
SELECT 'skipped week one idle gate: PASS';
