BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'stats-correction-fixture', true);
INSERT INTO public.nba_games(id, nba_game_id, season_year, game_date, week_number, home_team, away_team, status, stats_synced_at, game_time)
VALUES
 ('e8120000-0000-4000-8000-000000000001','0022601991',2027,'2026-10-27',2,'BOS','NYK','Final','2026-10-28T09:00:00Z','2026-10-27T23:00:00Z'),
 ('e8120000-0000-4000-8000-000000000002','0022601992',2027,'2026-10-28',2,'LAL','LAC','Final','2026-10-28T10:15:00Z','2026-10-28T01:00:00Z'),
 ('e8120000-0000-4000-8000-000000000003','0022601993',2027,'2026-10-26',2,'MIA','ORL','Final','2026-10-27T09:00:00Z','2026-10-26T23:00:00Z');
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.get_live_poll_work('2026-10-28T10:20:00Z') WHERE id='e8120000-0000-4000-8000-000000000001' AND needs_stats) THEN
  RAISE EXCEPTION 'A quiet final game misses its correction recheck';
 END IF;
 IF EXISTS(SELECT 1 FROM public.get_live_poll_work('2026-10-28T10:20:00Z') WHERE id IN('e8120000-0000-4000-8000-000000000002','e8120000-0000-4000-8000-000000000003')) THEN
  RAISE EXCEPTION 'Fresh finals or old games entered the live correction poll';
 END IF;
 INSERT INTO private.live_poll_game_state(game_id,stats_attempted_at)
 VALUES('e8120000-0000-4000-8000-000000000001','2026-10-28T10:15:00Z');
 IF EXISTS(SELECT 1 FROM public.get_live_poll_work('2026-10-28T10:20:00Z') WHERE id='e8120000-0000-4000-8000-000000000001') THEN
  RAISE EXCEPTION 'A failed attempt retries before its thirty-minute limit';
 END IF;
END;
$$;
DO $$
DECLARE
 v_first uuid;
 v_repeated uuid;
 v_later uuid;
BEGIN
 IF public.queue_daily_stat_corrections('2026-10-28T10:19:59Z') IS NOT NULL THEN
  RAISE EXCEPTION 'Daily corrections start before 06:20 Eastern';
 END IF;
 v_first := public.queue_daily_stat_corrections('2026-10-28T10:20:00Z');
 IF v_first IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.sync_jobs WHERE id=v_first
   AND metadata->>'startDate'='2026-10-21' AND metadata->>'endDate'='2026-10-27'
 ) THEN
  RAISE EXCEPTION 'Daily corrections did not queue the previous seven Eastern dates';
 END IF;
 v_repeated := public.queue_daily_stat_corrections('2026-10-28T22:00:00Z');
 IF v_first IS DISTINCT FROM v_repeated THEN
  RAISE EXCEPTION 'Daily corrections queued duplicate work';
 END IF;
 UPDATE public.sync_jobs SET status='completed',completed_at=now() WHERE id=v_first;
 IF public.queue_daily_stat_corrections('2026-10-28T23:00:00Z') IS DISTINCT FROM v_first THEN
  RAISE EXCEPTION 'A completed daily correction restarted on the same day';
 END IF;
 IF public.queue_daily_stat_corrections('2026-11-02T11:19:59Z') IS NOT NULL THEN
  RAISE EXCEPTION 'Daily corrections ignore the Eastern daylight-saving change';
 END IF;
 v_later := public.queue_daily_stat_corrections('2026-11-02T11:20:00Z');
 IF v_later IS NULL OR v_later=v_first OR NOT EXISTS(
  SELECT 1 FROM public.sync_jobs WHERE id=v_later
   AND metadata->>'startDate'='2026-10-26' AND metadata->>'endDate'='2026-11-01'
 ) THEN
  RAISE EXCEPTION 'The next daily correction has the wrong date window';
 END IF;
 IF has_function_privilege('anon','public.queue_daily_stat_corrections(timestamptz)','EXECUTE')
  OR has_function_privilege('authenticated','public.queue_daily_stat_corrections(timestamptz)','EXECUTE') THEN
  RAISE EXCEPTION 'A client can queue administrative corrections';
 END IF;
END;
$$;
ROLLBACK;
