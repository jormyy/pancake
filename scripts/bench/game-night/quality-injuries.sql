\set ON_ERROR_STOP on
BEGIN;
\ir ../../../tests/db/rules-support.sql
DO $$
DECLARE tick timestamptz;
BEGIN
  FOREACH tick IN ARRAY ARRAY['9542-01-05 09:00 America/New_York'::timestamptz,
    '9542-01-05 10:00 America/New_York'::timestamptz,'9542-01-05 11:00 America/New_York'::timestamptz] LOOP
    PERFORM private.enqueue_player_injuries(tick);
    UPDATE private.work_items SET status='succeeded' WHERE kind='player-injuries' AND key LIKE '%9542-01-05%';
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='player-injuries' AND key LIKE '%9542-01-05%'),'off-day injuries run once daily');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('quality-injury',9542,1,'9542-01-06','9542-01-06 19:00 America/New_York','BOS','NYK','Scheduled');
  FOREACH tick IN ARRAY ARRAY['9542-01-06 16:00 America/New_York'::timestamptz,
    '9542-01-06 16:15 America/New_York'::timestamptz,'9542-01-06 16:30 America/New_York'::timestamptz,
    '9542-01-06 16:45 America/New_York'::timestamptz,'9542-01-06 17:00 America/New_York'::timestamptz,
    '9542-01-06 17:15 America/New_York'::timestamptz,'9542-01-06 17:30 America/New_York'::timestamptz,
    '9542-01-06 17:45 America/New_York'::timestamptz] LOOP
    PERFORM private.enqueue_player_injuries(tick);
    UPDATE private.work_items SET status='succeeded' WHERE kind='player-injuries' AND key LIKE '%9542-01-06%';
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=5 FROM private.work_items WHERE kind='player-injuries' AND key LIKE '%9542-01-06%'),'injuries switch from hourly to quarter-hour two hours before tipoff');
  PERFORM private.enqueue_player_injuries('9542-01-06 19:15 America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=5 FROM private.work_items WHERE kind='player-injuries' AND key LIKE '%9542-01-06%'),'injuries stop after the last tipoff');
END;
$$;
SELECT count(*) passed_checks FROM rules_checks;
ROLLBACK;
