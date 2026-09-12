-- ET-time cron gates: due from the target time onward, dispatched once per
-- period, so a late tick catches up and a repeated tick does not double-fire.
-- Observable through edge_invocations (invoke_edge_function records one row per
-- pg_net request). The GUCs point at an unreachable loopback port: pg_net
-- only enqueues here, nothing is contacted.
BEGIN;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'cron-dispatch-test-token', true);
DELETE FROM public.cron_dispatch_state WHERE job_key IN ('et-time:cron-test-fn', 'et-time:sync-rankings', 'season-boundary');

CREATE TEMP TABLE dispatch_counts (label text, n bigint);
CREATE OR REPLACE FUNCTION pg_temp.invocations(p_fn text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.edge_invocations WHERE function_name = p_fn AND queued_at >= now() - interval '1 minute'
$$;

-- daily gate: 03:00 ET target
SELECT public.invoke_edge_function_at_et_time('cron-test-fn', 3, 0, '2026-01-14 02:59:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'before target', pg_temp.invocations('cron-test-fn');
SELECT public.invoke_edge_function_at_et_time('cron-test-fn', 3, 0, '2026-01-14 03:01:07 America/New_York');
INSERT INTO dispatch_counts SELECT 'late tick (03:01:07)', pg_temp.invocations('cron-test-fn');
SELECT public.invoke_edge_function_at_et_time('cron-test-fn', 3, 0, '2026-01-14 04:00:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'second tick same day', pg_temp.invocations('cron-test-fn');
SELECT public.invoke_edge_function_at_et_time('cron-test-fn', 3, 0, '2026-01-15 04:00:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'next day catch-up', pg_temp.invocations('cron-test-fn');

-- weekly gate (Monday 07:00 ET): a Tuesday tick catches up once, the next Monday fires again
SELECT public.invoke_dynasty_ranking_views_at_et_time(7, 0, '2026-01-12 06:59:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'weekly before target', pg_temp.invocations('sync-rankings');
SELECT public.invoke_dynasty_ranking_views_at_et_time(7, 0, '2026-01-13 08:00:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'weekly tuesday catch-up', pg_temp.invocations('sync-rankings');
SELECT public.invoke_dynasty_ranking_views_at_et_time(7, 0, '2026-01-14 08:00:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'weekly wednesday no double', pg_temp.invocations('sync-rankings');
SELECT public.invoke_dynasty_ranking_views_at_et_time(7, 0, '2026-01-19 07:00:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'weekly next monday', pg_temp.invocations('sync-rankings');

-- season boundary: needs an eligible league; due from 09:00 ET once per day
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000098001', 'authenticated', 'authenticated', 'dispatch-gate@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, invite_code, commissioner_id, status)
VALUES ('00000000-0000-0000-0000-000000098101', 'Dispatch Gate League', 'dispatch-gate-league', 'DISPATCHGATE0000', '00000000-0000-0000-0000-000000098001', 'active');
SELECT public.invoke_season_boundary_if_due('2026-01-14 08:59:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'boundary before 09:00', pg_temp.invocations('season-boundary');
SELECT public.invoke_season_boundary_if_due('2026-01-14 10:00:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'boundary late tick', pg_temp.invocations('season-boundary');
SELECT public.invoke_season_boundary_if_due('2026-01-14 10:00:00 America/New_York');
INSERT INTO dispatch_counts SELECT 'boundary repeat', pg_temp.invocations('season-boundary');

DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT * FROM dispatch_counts LOOP RAISE NOTICE '% -> %', v.label, v.n; END LOOP;
  IF (SELECT n FROM dispatch_counts WHERE label = 'before target') <> 0 THEN RAISE EXCEPTION 'fired before the target time'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'late tick (03:01:07)') <> 1 THEN RAISE EXCEPTION 'late tick did not catch up'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'second tick same day') <> 1 THEN RAISE EXCEPTION 'double dispatch in one day'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'next day catch-up') <> 2 THEN RAISE EXCEPTION 'next day did not dispatch'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'weekly before target') <> 0 THEN RAISE EXCEPTION 'weekly fired before target'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'weekly tuesday catch-up') <> 3 THEN RAISE EXCEPTION 'weekly catch-up did not dispatch three views'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'weekly wednesday no double') <> 3 THEN RAISE EXCEPTION 'weekly double dispatch'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'weekly next monday') <> 6 THEN RAISE EXCEPTION 'next week did not dispatch'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'boundary before 09:00') <> 0 THEN RAISE EXCEPTION 'boundary fired before 09:00'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'boundary late tick') <> 1 THEN RAISE EXCEPTION 'boundary late tick did not catch up'; END IF;
  IF (SELECT n FROM dispatch_counts WHERE label = 'boundary repeat') <> 1 THEN RAISE EXCEPTION 'boundary double dispatch'; END IF;
END $$;
ROLLBACK;
