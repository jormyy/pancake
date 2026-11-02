BEGIN;
DELETE FROM private.work_items;
CREATE TEMP TABLE schedule_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_schedule(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO schedule_checks VALUES(label);
END;
$$;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES
  (2027,1,'2026-10-20','2026-10-25'),(2027,2,'2026-10-26','2026-11-01'),
  (2027,3,'2026-11-02','2026-11-08'),(2027,22,'2027-03-15','2027-03-21');
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES
  ('0029918001',2027,2,'2026-10-26','2026-10-27T02:00:00Z','BOS','NYK','Scheduled'),
  ('0029918002',2027,3,'2026-11-02','2026-11-03T03:00:00Z','BOS','NYK','Scheduled'),
  ('0029918003',2027,22,'2027-03-15','2027-03-16T02:00:00Z','BOS','NYK','Scheduled');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26T14:59:59Z')),'morning refresh waits until eight Pacific');
SELECT pg_temp.check_schedule((SELECT count(*)=2 FROM private.projection_sync_due_work('2026-10-26T15:00:00Z') WHERE period_key='2026-10-26:08'),'both projection sources run in the morning');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26T19:00:00Z')),'the removed noon refresh stays off');
SELECT pg_temp.check_schedule((SELECT count(*)=2 FROM private.projection_sync_due_work('2026-10-27T01:00:00Z') WHERE period_key='2026-10-26:pregame'),'both sources refresh one hour before first tipoff');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-27T02:00:00Z')),'pregame refresh stops at tipoff');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-11-02T15:59:59Z')),'fall DST retains eight local');
SELECT pg_temp.check_schedule((SELECT count(*)=2 FROM private.projection_sync_due_work('2026-11-02T16:00:00Z')),'fall DST starts the morning window');
SELECT pg_temp.check_schedule((SELECT count(*)=2 FROM private.projection_sync_due_work('2027-03-15T15:00:00Z')),'spring DST starts at eight local');
SELECT private.enqueue_projection_sync('2026-10-26T15:00:00Z');
SELECT private.enqueue_projection_sync('2026-10-26T15:15:00Z');
SELECT pg_temp.check_schedule((SELECT count(*)=2 FROM private.work_items WHERE kind IN('pt:sleeper-day','pt:fantasypros')),'repeated morning ticks share two work items');
UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL,completed_at=now();
SELECT private.enqueue_projection_sync('2026-10-27T01:00:00Z');
SELECT pg_temp.check_schedule((SELECT count(*)=4 FROM private.work_items WHERE kind IN('pt:sleeper-day','pt:fantasypros')),'pregame work remains separate from completed morning work');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pt:sleeper-week'),'the old weekly polling tier creates no work');
SELECT count(*) AS passed FROM schedule_checks;
ROLLBACK;
