-- 1. A Final game with no box score wakes live-poll (probe P4 2026-09-12: it did not).
-- 2. A live-poll holder can renew its lease; a lapsed holder cannot.
BEGIN;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'live-poll-gate-test-token', true);
-- Never delete real rows: if the database already has games on the two candidate
-- dates, the gate may already be armed; that case is reported and skipped.
SELECT set_config('test.preexisting_games', (SELECT count(*) FROM public.nba_games WHERE game_date IN ((timezone('America/New_York', now()))::date - 1, (timezone('America/New_York', now()))::date))::text, true);
SELECT public.invoke_live_poll_if_due();
SELECT set_config('test.before_final', (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'live-poll' AND queued_at >= now() - interval '1 minute')::text, true);
INSERT INTO public.nba_games (id, season_year, game_date, week_number, home_team, away_team, status)
VALUES ('00000000-0000-4000-8000-0000000000e1', 2026, (timezone('America/New_York', now()))::date - 1, 1, 'BOS', 'MIA', 'Final');
SELECT public.invoke_live_poll_if_due();
SELECT set_config('test.after_final', (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'live-poll' AND queued_at >= now() - interval '1 minute')::text, true);
-- A Final game that already has its box score must not keep the poll awake.
INSERT INTO public.players (id, sportsdata_id, first_name, last_name, position, eligible_positions, status, nba_team)
VALUES ('00000000-0000-4000-8000-0000000000e2', 'live-poll-gate-fixture', 'Gate', 'Fixture', 'PG', ARRAY['PG'], 'Active', 'BOS');
INSERT INTO public.player_game_stats (player_id, game_id, season_year, week_number, minutes_played, points, rebounds, assists, steals, blocks)
VALUES ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000e1', 2026, 1, 1, 0, 0, 0, 0, 0);
SELECT set_config('test.after_stats', (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'live-poll' AND queued_at >= now() - interval '1 minute')::text, true);
SELECT public.invoke_live_poll_if_due();
SELECT set_config('test.after_stats2', (SELECT count(*) FROM public.edge_invocations WHERE function_name = 'live-poll' AND queued_at >= now() - interval '1 minute')::text, true);
DO $$
BEGIN
  IF current_setting('test.preexisting_games')::int > 0 THEN
    RAISE NOTICE 'skipping the gate assertions: % real game(s) already on the candidate dates', current_setting('test.preexisting_games');
    RETURN;
  END IF;
  IF current_setting('test.before_final')::int <> 0 THEN RAISE EXCEPTION 'live-poll fired with no games at all'; END IF;
  IF current_setting('test.after_final')::int <> 1 THEN RAISE EXCEPTION 'a Final game without stats did not wake live-poll (got %)', current_setting('test.after_final'); END IF;
  IF current_setting('test.after_stats2')::int <> current_setting('test.after_stats')::int THEN
    RAISE EXCEPTION 'a Final game that has its stats woke live-poll again';
  END IF;
END $$;

DELETE FROM public.live_poll_leases WHERE lock_key = 998001;
SELECT set_config('test.holder', public.try_live_poll_lease(998001, 90)::text, true);
DO $$
BEGIN
  IF NOT public.renew_live_poll_lease(998001, current_setting('test.holder')::uuid, 90) THEN RAISE EXCEPTION 'current holder could not renew'; END IF;
  IF public.try_live_poll_lease(998001, 90) IS NOT NULL THEN RAISE EXCEPTION 'renewed lease was taken over'; END IF;
  UPDATE public.live_poll_leases SET expires_at = now() - interval '1 second' WHERE lock_key = 998001;
  IF public.renew_live_poll_lease(998001, current_setting('test.holder')::uuid, 90) THEN RAISE EXCEPTION 'lapsed holder renewed its lease'; END IF;
  IF public.try_live_poll_lease(998001, 90) IS NULL THEN RAISE EXCEPTION 'lapsed lease could not be taken over'; END IF;
  IF public.renew_live_poll_lease(998001, current_setting('test.holder')::uuid, 90) THEN RAISE EXCEPTION 'displaced holder renewed after takeover'; END IF;
END $$;
ROLLBACK;
