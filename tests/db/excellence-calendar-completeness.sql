\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
CREATE TEMP TABLE calendar_source AS
SELECT jsonb_agg(to_jsonb(game)||jsonb_build_object('schedule_complete',true) ORDER BY nba_game_id) AS games
FROM public.nba_games game WHERE season_year=2027;
CREATE TEMP TABLE calendar_weeks AS
SELECT jsonb_agg(to_jsonb(week) ORDER BY week_number) AS weeks FROM public.season_weeks week WHERE season_year=2027;
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
SELECT '0022699999',season_year,week_number,game_date+1,home_team,away_team,'Scheduled'
FROM public.nba_games WHERE season_year=2027 ORDER BY nba_game_id LIMIT 1;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT public.publish_nba_schedule_atomic(2027,games,weeks) FROM calendar_source CROSS JOIN calendar_weeks;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM public.nba_games WHERE nba_game_id='0022699999'
    AND private.lineup_game_available(status,game_status_text)) THEN
    RAISE EXCEPTION 'An incomplete eighty-game schedule cancels a retained game';
  END IF;
END;
$$;
ROLLBACK;
