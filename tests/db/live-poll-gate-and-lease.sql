-- 1. A Final game with no box score wakes live-poll (probe P4 2026-09-12: it did not).
-- 2. A live-poll holder can renew its lease; a lapsed holder cannot.
BEGIN;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'live-poll-gate-test-token', true);
DELETE FROM public.nba_games WHERE game_date IN ((timezone('America/New_York', now()))::date - 1, (timezone('America/New_York', now()))::date);
SELECT public.invoke_live_poll_if_due();
SELECT count(*) AS before_final FROM public.edge_invocations WHERE function_name = 'live-poll' AND queued_at >= now() - interval '1 minute' \gset
INSERT INTO public.nba_games (id, season_year, game_date, week_number, home_team, away_team, status)
VALUES ('00000000-0000-4000-8000-0000000000e1', 2026, (timezone('America/New_York', now()))::date - 1, 1, 'BOS', 'MIA', 'Final');
SELECT public.invoke_live_poll_if_due();
SELECT count(*) AS after_final FROM public.edge_invocations WHERE function_name = 'live-poll' AND queued_at >= now() - interval '1 minute' \gset
DO $$
BEGIN
  IF :before_final <> 0 THEN RAISE EXCEPTION 'live-poll fired with no games at all'; END IF;
  IF :after_final <> 1 THEN RAISE EXCEPTION 'a Final game without stats did not wake live-poll (got %)', :after_final; END IF;
END $$;

DELETE FROM public.live_poll_leases WHERE lock_key = 998001;
SELECT public.try_live_poll_lease(998001, 90) AS holder \gset
DO $$
BEGIN
  IF NOT public.renew_live_poll_lease(998001, :'holder', 90) THEN RAISE EXCEPTION 'current holder could not renew'; END IF;
  IF public.try_live_poll_lease(998001, 90) IS NOT NULL THEN RAISE EXCEPTION 'renewed lease was taken over'; END IF;
  UPDATE public.live_poll_leases SET expires_at = now() - interval '1 second' WHERE lock_key = 998001;
  IF public.renew_live_poll_lease(998001, :'holder', 90) THEN RAISE EXCEPTION 'lapsed holder renewed its lease'; END IF;
  IF public.try_live_poll_lease(998001, 90) IS NULL THEN RAISE EXCEPTION 'lapsed lease could not be taken over'; END IF;
  IF public.renew_live_poll_lease(998001, :'holder', 90) THEN RAISE EXCEPTION 'displaced holder renewed after takeover'; END IF;
END $$;
ROLLBACK;
