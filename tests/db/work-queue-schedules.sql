BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
CREATE FUNCTION pg_temp.queued(p_kind text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM private.work_items WHERE kind=p_kind
$$;
CREATE FUNCTION pg_temp.finished() RETURNS void LANGUAGE sql AS $$
  UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL
$$;
CREATE FUNCTION pg_temp.scheduled(p_at timestamptz,p_kind text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work(p_at);
  RETURN pg_temp.queued(p_kind)>0;
END;
$$;
DO $$
DECLARE fixture record; v_ref timestamptz; v_day date:='9541-01-03';
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9541,'active');
  FOREACH v_ref IN ARRAY ARRAY['2026-03-08 03:00 America/New_York'::timestamptz,'2026-11-01 03:00 America/New_York'::timestamptz] LOOP
    DELETE FROM private.work_items;
    PERFORM private.enqueue_daily('process-waivers',3,0,v_ref-interval '1 second');
    PERFORM pg_temp.check_rules(pg_temp.queued('process-waivers')=0,'waivers before DST cutoff '||v_ref);
    PERFORM private.enqueue_daily('process-waivers',3,0,v_ref+interval '1 second');
    PERFORM pg_temp.finished();
    PERFORM private.enqueue_daily('process-waivers',3,0,v_ref+interval '5 hours');
    PERFORM pg_temp.check_rules(pg_temp.queued('process-waivers')=1,'waivers once after late DST cutoff '||v_ref);
    PERFORM private.enqueue_daily('process-waivers',3,0,v_ref+interval '25 hours');
    PERFORM pg_temp.check_rules(pg_temp.queued('process-waivers')=2,'next daily waiver run '||v_ref);
  END LOOP;
  DELETE FROM private.work_items;
  PERFORM private.enqueue_daily('sync-players',6,0,'2026-01-14 05:59:59 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('sync-players')=0,'players wait until six ET');
  PERFORM private.enqueue_daily('sync-players',6,0,'2026-01-14 06:00:01 America/New_York');
  PERFORM pg_temp.finished();
  PERFORM private.enqueue_daily('sync-players',6,0,'2026-01-14 23:59 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('sync-players')=1,'players catch up once per ET day');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_rankings('2026-01-12 03:59:59 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('sync-rankings')=0,'rankings wait until four ET');
  PERFORM private.enqueue_rankings('2026-01-13 04:00 America/New_York');
  PERFORM pg_temp.finished();
  PERFORM private.enqueue_rankings('2026-01-13 05:00 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('sync-rankings')=3,'rankings run once per day and view');
  PERFORM private.enqueue_rankings('2026-01-14 04:00 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('sync-rankings')=6,'rankings enqueue all three next-day views');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_kinds WHERE kind='sync-rankings' AND function_name='sync-rankings'),'Hashtag work targets its worker');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-01-20 08:59 UTC','sync-rankings'),'rankings wait for the hour');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-01-20 09:00 UTC','sync-rankings'),'rankings wake each hour');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_season_boundary('2026-01-14 08:59:59 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('season-boundary')=0,'season boundary waits for nine ET');
  PERFORM private.enqueue_season_boundary('2026-01-14 10:00 America/New_York');
  PERFORM pg_temp.finished();
  PERFORM private.enqueue_season_boundary('2026-01-14 23:59 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('season-boundary')=1,'season boundary catches up once per ET day');
  UPDATE public.leagues SET status='drafting' WHERE id=fixture.league_id;
  PERFORM private.enqueue_season_boundary('2026-01-15 10:00 America/New_York');
  PERFORM pg_temp.check_rules(pg_temp.queued('season-boundary')=2,'drafting leagues retain the rookie backstop');
  DELETE FROM private.work_items;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
  VALUES('002injuryqueue',9541,1,v_day,'QX','QY','Scheduled',(v_day+time '22:00') AT TIME ZONE 'America/New_York');
  FOREACH v_ref IN ARRAY ARRAY[(v_day+time '19:59') AT TIME ZONE 'America/New_York',(v_day+time '20:00') AT TIME ZONE 'America/New_York',(v_day+time '20:01') AT TIME ZONE 'America/New_York',(v_day+time '20:15') AT TIME ZONE 'America/New_York'] LOOP
    PERFORM private.enqueue_player_injuries(v_ref); PERFORM pg_temp.finished();
  END LOOP;
  PERFORM pg_temp.check_rules(pg_temp.queued('player-injuries')=3,'injuries switch to quarter-hour two hours before the first tipoff');
  DELETE FROM private.work_items;
  FOREACH v_ref IN ARRAY ARRAY[(v_day+1+time '08:00') AT TIME ZONE 'America/New_York',(v_day+1+time '08:15') AT TIME ZONE 'America/New_York',(v_day+1+time '09:00') AT TIME ZONE 'America/New_York',(v_day+1+time '23:00') AT TIME ZONE 'America/New_York',(v_day+1+time '01:00') AT TIME ZONE 'America/New_York',(v_day+1+time '02:00') AT TIME ZONE 'America/New_York',(v_day+1+time '03:00') AT TIME ZONE 'America/New_York'] LOOP
    PERFORM private.enqueue_player_injuries(v_ref); PERFORM pg_temp.finished();
  END LOOP;
  PERFORM pg_temp.check_rules(pg_temp.queued('player-injuries')=1,'injuries run once on an off day');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 13:00:07 UTC','sync-draft-order'),'June draft window retains delayed cron seconds');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-19 13:00 UTC','sync-draft-order'),'June draft window excludes earlier days');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-07-15 13:00 UTC','sync-draft-order'),'July draft window includes fifteen');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-07-16 13:00 UTC','sync-draft-order'),'July draft window excludes sixteen');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 08:35:07 UTC','cleanup-trade-estimates'),'quote cleanup retains UTC time with delayed seconds');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 09:30:07 UTC','mock-room-expiry'),'mock expiry retains UTC time with delayed seconds');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-21 10:00:07 UTC','retention-prune'),'retention retains Sunday UTC time');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-22 10:00 UTC','retention-prune'),'retention includes Monday');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 13:17 UTC','pg-net-response-vacuum'),'response vacuum retains hourly minute seventeen');
  DELETE FROM public.edge_invocations;
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 13:05 UTC','edge-invocation-reconcile'),'idle reconciliation does not enqueue work');
  INSERT INTO public.edge_invocations(function_name) VALUES('schedule-fixture');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 13:05 UTC','edge-invocation-reconcile'),'reconciliation retains five-minute cadence');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 13:06 UTC','edge-invocation-reconcile'),'reconciliation excludes intermediate minutes');
  UPDATE public.edge_invocations SET reconciled_at=now(),worker_status='running';
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 13:10 UTC','edge-invocation-reconcile'),'running workers retain five-minute reconciliation');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 13:11 UTC','edge-invocation-reconcile'),'running reconciliation excludes intermediate minutes');
  UPDATE public.edge_invocations SET worker_status='succeeded';
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 13:15 UTC','edge-invocation-reconcile'),'completed invocations do not enqueue reconciliation');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 13:00 UTC','player-stats-hints'),'score hints avoid leased queue work');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_kinds WHERE kind='league-inventory-hint-drain' AND retired_at IS NULL),'inventory hint recovery remains available');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='io-hint-drain'),'hint work uses the shared dispatcher');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 10:00 UTC','sync-schedule'),'schedule retains its five-minute offset');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 10:05 UTC','sync-schedule'),'schedule starts at six-oh-five ET');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_lineup_optimizer((v_day+8)::timestamp AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'general lineup gate is idle without the next eight dates');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES('002queuegeneral',9541,1,v_day+15,'QX','QY','Scheduled');
  PERFORM private.enqueue_lineup_optimizer((v_day+8)::timestamp AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='lineup-optimizer'),'general lineup gate includes day seven');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 10:15 UTC','daily-stat-corrections'),'corrections wait until six-twenty ET');
  PERFORM pg_temp.check_rules(NOT pg_temp.scheduled('2026-06-20 10:30 UTC','daily-stat-corrections'),'corrections require a recent final regular-season game');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES('002queuecorrection',9541,1,'2026-06-19','QX','QY','Final');
  PERFORM pg_temp.check_rules(pg_temp.scheduled('2026-06-20 10:30 UTC','daily-stat-corrections'),'corrections enqueue at the first eligible quarter-hour');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
