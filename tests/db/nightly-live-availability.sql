BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='review-nightly';
\ir rules-support.sql
UPDATE public.nba_games SET status='Final' WHERE status='InProgress';
DO $$
DECLARE game uuid:=gen_random_uuid(); tick timestamptz:=((now() AT TIME ZONE 'America/New_York')::date+time '04:00') AT TIME ZONE 'America/New_York';
BEGIN
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_status_text)
    VALUES(game,'002-review-nightly',9537,1,(tick AT TIME ZONE 'America/New_York')::date,'BOS','NYK','InProgress','Cancelled: absent from complete schedule');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work(tick);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-players'),'cancelled games do not block nightly work');
  UPDATE public.nba_games SET game_status_text='Q3',game_date=game_date-3 WHERE id=game;
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work(tick);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-players'),'stale live rows do not block nightly work');
  UPDATE public.nba_games SET game_date=(tick AT TIME ZONE 'America/New_York')::date-1 WHERE id=game;
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work(tick);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-players'),'a relevant overnight game still blocks nightly work');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
