BEGIN;
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
  ('0029918003',2027,22,'2027-03-15','2027-03-16T02:00:00Z','BOS','NYK','Scheduled'),
  ('0029918004',2027,2,'2026-10-27','2026-10-28T02:00:00Z','BOS','NYK','Scheduled');
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26T07:00:00Z') WHERE job_key='pt:sleeper-week' AND period_key='2026-10-26'),'Monday midnight PDT starts its own week');
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-11-02T08:00:00Z') WHERE job_key='pt:sleeper-week' AND period_key='2026-11-02'),'Monday midnight PST starts its own week');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-11-02T07:59:59Z') WHERE job_key='pt:sleeper-week' AND period_key='2026-11-02'),'fall DST does not run Monday early');
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2027-03-15T07:00:00Z') WHERE job_key='pt:sleeper-week' AND period_key='2027-03-15'),'spring DST follows Pacific midnight');
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-23T18:00:00Z') WHERE job_key='pt:sleeper-week'),'first deployment catches up without waiting for Monday');
SELECT pg_temp.check_schedule(private.claim_cron_dispatch('pt:sleeper-week','2026-10-26') AND NOT private.claim_cron_dispatch('pt:sleeper-week','2026-10-26'),'weekly dispatch claim prevents duplicate ticks');
UPDATE public.cron_dispatch_state SET retry_after=clock_timestamp()-interval '1 second' WHERE job_key='pt:sleeper-week';
SELECT pg_temp.check_schedule(private.claim_cron_dispatch('pt:sleeper-week','2026-10-26'),'failed worker can retry through its dispatch claim');
SELECT pg_temp.check_schedule((SELECT schedule='*/15 * * * *' FROM cron.job WHERE jobname='nba-sync-projections'),'due-work gate runs every fifteen minutes');
UPDATE public.cron_dispatch_state SET attempts=3,retry_after=NULL WHERE job_key='pt:sleeper-week';
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM public.sleeper_projection_rows WHERE game_date BETWEEN '2026-10-26' AND '2026-11-01'),
  'failed Monday pull leaves an empty projection week');
SELECT pg_temp.check_schedule((SELECT count(*)=3 FROM unnest(ARRAY['2026-10-27T15:00:00Z','2026-10-27T19:00:00Z','2026-10-27T22:00:00Z']::timestamptz[]) tick
  CROSS JOIN LATERAL private.projection_sync_due_work(tick) work WHERE work.job_key='pt:sleeper-day'),
  'all three game-day windows run after Monday retries are exhausted without stored rows');
SELECT pg_temp.check_schedule(private.claim_cron_dispatch('pt:sleeper-day','2026-10-27:08'),
  'game-day claim is independent of the exhausted Monday claim');
DO $$
DECLARE p uuid:=gen_random_uuid();
BEGIN
  INSERT INTO public.players(id,first_name,last_name,position) VALUES(p,'Schedule','Fixture','PG');
  INSERT INTO public.sleeper_projection_rows(player_id,source_game_id,sleeper_id,season_year,week_number,game_date,team,opponent,
    points,rebounds,assists,steals,blocks,three_pointers_made,turnovers,field_goals_made,field_goals_attempted,
    free_throws_made,free_throws_attempted,three_pointers_attempted,minutes,last_modified)
  VALUES(p,'schedule-fixture','schedule-fixture',2027,2,'2026-10-26','BOS','NYK',0,0,0,0,0,0,0,0,0,0,0,0,0,1),
    (p,'schedule-fixture-pst','schedule-fixture',2027,3,'2026-11-02','BOS','NYK',0,0,0,0,0,0,0,0,0,0,0,0,0,1);
END;
$$;
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26T15:00:00Z') WHERE job_key='pt:sleeper-day' AND period_key='2026-10-26:08'),'08 Pacific refreshes before tipoff');
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26T19:04:00Z') WHERE job_key='pt:sleeper-day' AND period_key='2026-10-26:12'),'late tick catches the noon Pacific refresh');
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26T22:00:00Z') WHERE job_key='pt:sleeper-day' AND period_key='2026-10-26:15'),'15 Pacific refreshes before tipoff');
SELECT pg_temp.check_schedule(EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-11-02T16:00:00Z') WHERE job_key='pt:sleeper-day' AND period_key='2026-11-02:08'),'daily refresh follows DST');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-27T02:00:00Z') WHERE job_key='pt:sleeper-day'),'refresh stops at first tipoff');
SELECT pg_temp.check_schedule(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-28T22:00:00Z') WHERE job_key='pt:sleeper-day'),'no-game days have no injury refresh');
SELECT pg_temp.check_schedule((SELECT count(*)=1 FROM private.projection_sync_due_work('2026-10-26T15:00:00Z') WHERE job_key='pt:fantasypros' AND period_key='2026-10-26:08') AND
  (SELECT count(*)=1 FROM private.projection_sync_due_work('2026-10-26T22:00:00Z') WHERE job_key='pt:fantasypros' AND period_key='2026-10-26:15'),'FantasyPros runs at 08 and 15 Pacific');
SELECT count(*) AS passed FROM schedule_checks;
ROLLBACK;
