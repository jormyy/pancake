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

DO $$
BEGIN
  IF current_setting('live.test_api_port') !~ '^[0-9]+$' OR current_setting('live.test_db_port') !~ '^[0-9]+$'
    OR current_setting('app.supabase_url') !~ format('^https?://(127[.]0[.]0[.]1|localhost):%s/?$', current_setting('live.test_api_port'))
    OR current_setting('live.test_db_url') !~ format('^postgres(ql)?://([^/@]+@)?(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$', current_setting('live.test_db_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback API and database ports are allowed';
  END IF;
END;
$$;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'local-database-ci-token', true);
CREATE TEMP TABLE night_games(id uuid PRIMARY KEY);
CREATE TEMP TABLE night_timings(scenario text, milliseconds numeric);
DO $$
DECLARE
  v_game uuid;
  v_now timestamptz := now();
BEGIN
  FOR n IN 1..12 LOOP
    v_game := gen_random_uuid();
    INSERT INTO night_games VALUES(v_game);
    INSERT INTO nba_games(id, nba_game_id, game_date, season_year, week_number, home_team, away_team, status, game_time)
      VALUES(v_game, '002' || replace(v_game::text, '-', ''), (v_now AT TIME ZONE 'America/New_York')::date,
        2025, 22, 'NYK', 'CHA', 'Scheduled', v_now - (10 + n * 2) * interval '1 minute');
    INSERT INTO private.live_poll_game_state(game_id, checked_at) VALUES(v_game, v_now - interval '2 minutes');
  END LOOP;
END;
$$;
ANALYZE nba_games;
ANALYZE private.live_poll_game_state;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM get_live_poll_work();
EXPLAIN (ANALYZE, BUFFERS) SELECT invoke_live_poll_if_due();
DO $$
DECLARE
  v_start timestamptz;
BEGIN
  FOR n IN 1..100 LOOP
    v_start := clock_timestamp();
    PERFORM * FROM get_live_poll_work();
    INSERT INTO night_timings VALUES('selector', extract(epoch FROM clock_timestamp() - v_start) * 1000);
    v_start := clock_timestamp();
    PERFORM invoke_live_poll_if_due();
    INSERT INTO night_timings VALUES('gate', extract(epoch FROM clock_timestamp() - v_start) * 1000);
  END LOOP;
END;
$$;
SELECT 'SYNTHETIC' AS provenance, count(*) AS late_scheduled_games FROM night_games;
SELECT scenario, count(*) AS calls, round(avg(milliseconds), 3) AS mean_ms,
  round(max(milliseconds), 3) AS max_ms FROM night_timings GROUP BY scenario ORDER BY scenario;
ROLLBACK;
