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
DECLARE
  v_game uuid := gen_random_uuid();
  v_tip timestamptz := '2026-03-26 23:00:00Z';
  v_now timestamptz;
BEGIN
  IF current_setting('live.test_api_port') !~ '^[0-9]+$' OR current_setting('live.test_db_port') !~ '^[0-9]+$'
    OR current_setting('app.supabase_url') !~ format('^https?://(127[.]0[.]0[.]1|localhost):%s/?$', current_setting('live.test_api_port'))
    OR current_setting('live.test_db_url') !~ format('^postgres(ql)?://([^/@]+@)?(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$', current_setting('live.test_db_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback API and database ports are allowed';
  END IF;
  INSERT INTO nba_games(id, nba_game_id, game_date, season_year, week_number, home_team, away_team, status, game_time)
    VALUES(v_game, '002' || replace(v_game::text, '-', ''), '2026-03-26', 2025, 22, 'NYK', 'CHA', 'Scheduled', v_tip);
  INSERT INTO private.live_poll_game_state(game_id, checked_at) VALUES(v_game, v_tip);
  FOREACH v_now IN ARRAY ARRAY[v_tip + interval '11 minutes', v_tip + interval '43 minutes', v_tip + interval '45 minutes'] LOOP
    UPDATE private.live_poll_game_state SET checked_at = v_now - interval '2 minutes' WHERE game_id = v_game;
    IF NOT EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game AND needs_scoreboard AND NOT needs_stats) THEN
      RAISE EXCEPTION 'Delayed Scheduled game must stay board-due at % minutes', extract(epoch FROM v_now - v_tip) / 60;
    END IF;
  END LOOP;
  v_now := v_tip + interval '45 minutes 0.001 seconds';
  IF EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game) THEN
    RAISE EXCEPTION 'Past the late-tip window, a recent check must throttle polling';
  END IF;
  UPDATE private.live_poll_game_state SET checked_at = v_now - interval '29 minutes 59.999 seconds' WHERE game_id = v_game;
  IF EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game) THEN
    RAISE EXCEPTION 'Late Scheduled throttle must wait the full thirty minutes';
  END IF;
  UPDATE private.live_poll_game_state SET checked_at = v_now - interval '30 minutes' WHERE game_id = v_game;
  IF NOT EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game AND needs_scoreboard AND NOT needs_stats) THEN
    RAISE EXCEPTION 'Late Scheduled throttle must include the thirty-minute boundary';
  END IF;
  UPDATE nba_games SET game_time = v_now + interval '2 minutes 0.001 seconds' WHERE id = v_game;
  IF EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game) THEN
    RAISE EXCEPTION 'Future Scheduled game must wait for the two-minute horizon';
  END IF;
  UPDATE nba_games SET game_time = v_now + interval '2 minutes' WHERE id = v_game;
  IF NOT EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game AND needs_scoreboard) THEN
    RAISE EXCEPTION 'Scheduled horizon must include two minutes';
  END IF;
  UPDATE nba_games SET game_time = v_tip, status = 'InProgress' WHERE id = v_game;
  UPDATE private.live_poll_game_state SET checked_at = v_now, stats_attempted_at = v_now WHERE game_id = v_game;
  IF NOT EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game AND needs_scoreboard AND needs_stats) THEN
    RAISE EXCEPTION 'InProgress polling must ignore Scheduled backoff';
  END IF;
  UPDATE nba_games SET status = 'Final', stats_synced_at = NULL WHERE id = v_game;
  IF EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game) THEN
    RAISE EXCEPTION 'Final stats must keep their recent-attempt backoff';
  END IF;
  UPDATE private.live_poll_game_state SET stats_attempted_at = v_now - interval '30 minutes' WHERE game_id = v_game;
  IF NOT EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game AND needs_stats AND NOT needs_scoreboard) THEN
    RAISE EXCEPTION 'Final stats must retain their thirty-minute retry boundary';
  END IF;
  UPDATE nba_games SET stats_synced_at = v_now WHERE id = v_game;
  IF EXISTS (SELECT 1 FROM get_live_poll_work(v_now) WHERE id = v_game) THEN
    RAISE EXCEPTION 'Fresh Final stats must remain idle';
  END IF;
  RAISE NOTICE 'PASS: delayed tipoff window, throttle boundaries, future, InProgress and Final';
END;
$$;
ROLLBACK;
