\getenv live_test_api_url SUPABASE_URL
\getenv live_test_db_url SUPABASE_DB_URL
\getenv live_test_api_port PANCAKE_TEST_API_PORT
\getenv live_test_db_port PANCAKE_TEST_DB_PORT
\if :{?live_test_api_url}
\else
  \echo SUPABASE_URL is required
  \quit 3
\endif
\if :{?live_test_db_url}
\else
  \echo SUPABASE_DB_URL is required
  \quit 3
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
  v_user uuid := gen_random_uuid();
  v_other_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_home uuid := gen_random_uuid();
  v_away uuid := gen_random_uuid();
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_before bigint;
  v_after bigint;
  v_matchup uuid := gen_random_uuid();
  v_second uuid := gen_random_uuid();
  v_week int;
  v_case int;
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
  SELECT candidate.year INTO v_year FROM generate_series(8993, 9093) AS candidate(year)
    WHERE NOT EXISTS (SELECT 1 FROM season_weeks WHERE season_year = candidate.year)
      AND NOT EXISTS (SELECT 1 FROM league_seasons WHERE season_year = candidate.year)
      AND NOT EXISTS (SELECT 1 FROM nba_games WHERE season_year = candidate.year)
    ORDER BY candidate.year LIMIT 1;
  IF v_year IS NULL THEN RAISE EXCEPTION 'No unused fixture season year'; END IF;

  INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    VALUES(v_user, 'authenticated', 'authenticated', v_user || '@example.test', '{}', '{}'),
      (v_other_user, 'authenticated', 'authenticated', v_other_user || '@example.test', '{}', '{}');
  INSERT INTO leagues(id, name, slug, commissioner_id, status)
    VALUES(v_league, 'Synthetic idle scoring', v_league::text, v_user, 'active');
  INSERT INTO league_seasons(id, league_id, season_year, is_current)
    VALUES(v_season, v_league, v_year, true);
  INSERT INTO league_members(id, league_id, user_id, role, team_name)
    VALUES(v_home, v_league, v_user, 'commissioner', 'Home'),
      (v_away, v_league, v_other_user, 'manager', 'Away');
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    VALUES(v_year, 1, v_today - 13, v_today - 7);
  INSERT INTO matchups(id, league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type)
    VALUES(v_matchup, v_league, v_season, 1, v_home, v_away, 'regular_season');
  SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
  PERFORM invoke_live_poll_if_due();
  SELECT count(*) INTO v_after FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'Closed week without another game day did not dispatch scoring: before %, after %', v_before, v_after;
  END IF;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_after THEN
    RAISE EXCEPTION 'Idle scoring does not respect its retry interval';
  END IF;
  UPDATE edge_invocations SET queued_at = now() - interval '29 minutes'
    WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text AND queued_at >= now();
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_after THEN
    RAISE EXCEPTION 'Idle scoring retries before thirty minutes';
  END IF;
  UPDATE edge_invocations SET queued_at = now() - interval '31 minutes'
    WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text AND queued_at > now() - interval '30 minutes';
  UPDATE leagues SET status = 'playoffs' WHERE id = v_league;
  UPDATE matchups SET matchup_type = 'playoff_final', end_week_number = 1 WHERE id = v_matchup;
  SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
  PERFORM invoke_live_poll_if_due();
  SELECT count(*) INTO v_after FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'Playoff final without later game days did not dispatch scoring';
  END IF;
  UPDATE edge_invocations SET queued_at = now() - interval '31 minutes'
    WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text AND queued_at >= now();
  UPDATE season_weeks SET week_start = v_today - 8, week_end = v_today - 2 WHERE season_year = v_year;
  UPDATE matchups SET is_finalized = true, finalized_at = now(), winner_member_id = v_home WHERE id = v_matchup;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_after THEN
    RAISE EXCEPTION 'Finalized playoff final keeps idle scoring awake during grace';
  END IF;
  UPDATE matchups SET is_finalized = false WHERE id = v_matchup;
  UPDATE leagues SET status = 'offseason' WHERE id = v_league;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_after THEN
    RAISE EXCEPTION 'Offseason league wakes idle scoring';
  END IF;
  UPDATE leagues SET status = 'archived' WHERE id = v_league;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_after THEN
    RAISE EXCEPTION 'Archived league wakes idle scoring';
  END IF;
  UPDATE leagues SET status = 'active' WHERE id = v_league;
  UPDATE matchups SET matchup_type = 'regular_season', is_finalized = true WHERE id = v_matchup;
  PERFORM invoke_live_poll_if_due();
  SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
  IF v_before <> v_after + 1 THEN RAISE EXCEPTION 'Recent closed week does not recover corrections'; END IF;
  UPDATE edge_invocations SET queued_at = now() - interval '31 minutes'
    WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text AND queued_at >= now();
  UPDATE season_weeks SET week_start = v_today - 14, week_end = v_today - 8 WHERE season_year = v_year;
  INSERT INTO private.score_week_certificates(league_season_id, week_number, input_token)
    VALUES(v_season, 1, capture_score_inputs(v_season, 1));
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_before THEN
    RAISE EXCEPTION 'Settled All-Star break week keeps scoring awake';
  END IF;
  UPDATE leagues SET scoring_settings = '{"points":2}' WHERE id = v_league;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_before + 1 THEN
    RAISE EXCEPTION 'Stale finalized week does not recover corrected scoring inputs';
  END IF;
  UPDATE edge_invocations SET queued_at = now() - interval '31 minutes'
    WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text AND queued_at >= now();
  UPDATE season_weeks SET week_start = v_today - 28, week_end = v_today - 22 WHERE season_year = v_year;
  INSERT INTO season_weeks(season_year, week_number, week_start, week_end)
    VALUES(v_year, 2, v_today - 21, v_today - 15), (v_year, 3, v_today - 14, v_today - 8);
  INSERT INTO matchups(id, league_id, league_season_id, week_number, home_member_id, away_member_id, matchup_type, is_finalized)
    VALUES(v_second, v_league, v_season, 2, v_home, v_away, 'regular_season', true);
  FOR v_week IN 1..2 LOOP
    INSERT INTO private.score_week_certificates(league_season_id, week_number, input_token)
      VALUES(v_season, v_week, capture_score_inputs(v_season, v_week))
      ON CONFLICT(league_season_id, week_number) DO UPDATE SET input_token = EXCLUDED.input_token;
  END LOOP;
  SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_before THEN
    RAISE EXCEPTION 'Current certificates across several settled weeks wake scoring';
  END IF;
  UPDATE private.score_week_certificates SET input_token = jsonb_set(input_token, ARRAY['nba:' || v_year || ':1'], '"-1"')
    WHERE league_season_id = v_season AND week_number = 1;
  PERFORM invoke_live_poll_if_due();
  IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_before + 1 THEN
    RAISE EXCEPTION 'Earlier stale certificate is hidden by a current later certificate';
  END IF;
  UPDATE edge_invocations SET queued_at = now() - interval '31 minutes'
    WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text AND queued_at >= now();
  FOR v_case IN 1..2 LOOP
    UPDATE matchups SET matchup_type = 'playoff_semifinal',
      end_week_number = CASE WHEN v_case = 2 THEN 2 ELSE 3 END WHERE id = v_second;
    FOR v_week IN 1..2 LOOP
      UPDATE private.score_week_certificates SET input_token = capture_score_inputs(v_season, v_week)
        WHERE league_season_id = v_season AND week_number = v_week;
    END LOOP;
    SELECT count(*) INTO v_before FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text;
    PERFORM invoke_live_poll_if_due();
    IF (SELECT count(*) FROM edge_invocations WHERE function_name = 'sync-scores' AND id > v_invocation_floor AND xmin::text = pg_current_xact_id()::text) <> v_before THEN
      RAISE EXCEPTION 'Round or span certificate comparison changes during case %', v_case;
    END IF;
  END LOOP;
END;
$$;
ROLLBACK;
SELECT 'weekly idle scoring dispatch: PASS';
