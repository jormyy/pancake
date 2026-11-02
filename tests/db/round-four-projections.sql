\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
VALUES(2026,17,'2026-02-09','2026-02-22')
ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end;
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
VALUES('002-round-four-projections',2026,17,'2026-02-19','2026-02-19 19:00 America/Los_Angeles','BOS','NYK','Scheduled');
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-02-19 08:00 America/Los_Angeles') WHERE job_key='pt:sleeper-day')
    OR NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-02-19 18:00 America/Los_Angeles') WHERE job_key='pt:sleeper-day') THEN
    RAISE EXCEPTION 'The second All-Star week must retain both projection windows';
  END IF;
  IF EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-02-19 12:00 America/Los_Angeles')) THEN
    RAISE EXCEPTION 'The change must not add a midday projection run';
  END IF;
END $$;
ROLLBACK;
