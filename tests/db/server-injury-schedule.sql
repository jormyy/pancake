BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE injury_dispatches(job text, name text, body jsonb);
CREATE OR REPLACE FUNCTION private.invoke_claimed_edge_function(p_job_key text,p_function_name text,p_body jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$ INSERT INTO injury_dispatches VALUES(p_job_key,p_function_name,p_body); $$;
DO $$
DECLARE game_day date:=date '9541-01-03';
BEGIN
  DELETE FROM nba_games WHERE game_date BETWEEN game_day AND game_day+1;
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES('002injury',9541,1,game_day,'FTX','FTY','Scheduled',(game_day+time '22:00') AT TIME ZONE 'America/New_York');
  PERFORM public.invoke_edge_function_at_et_time('sync-players',6,0,(game_day+time '10:59') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM injury_dispatches WHERE job='et:player-injuries'),'injuries waits until eleven ET');
  PERFORM public.invoke_edge_function_at_et_time('sync-players',6,0,(game_day+time '11:00') AT TIME ZONE 'America/New_York');
  PERFORM public.invoke_edge_function_at_et_time('sync-players',6,0,(game_day+time '11:01') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM injury_dispatches WHERE name='sync-players' AND body='{"mode":"injuries"}'::jsonb AND job='et:player-injuries'),'game-day quarter hour uses the dispatcher and exact injuries body');
  PERFORM public.invoke_edge_function_at_et_time('sync-players',6,0,(game_day+time '11:15') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM injury_dispatches WHERE job='et:player-injuries'),'next quarter hour dispatches');
  PERFORM public.invoke_edge_function_at_et_time('sync-players',6,0,(game_day+time '22:01') AT TIME ZONE 'America/New_York');
  PERFORM public.invoke_edge_function_at_et_time('sync-players',6,0,(game_day+1+time '12:00') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM injury_dispatches WHERE job='et:player-injuries'),'after last tipoff and off days do not dispatch');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM cron.job WHERE jobname='nba-sync-players' AND schedule='*/15 * * * *' AND command ILIKE '%invoke_edge_function_at_et_time%'),'existing quarter-hour player cron calls the game-day gate');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM injury_dispatches WHERE job='et-time:sync-players' AND body='{}'::jsonb),'full player refresh remains once per day');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
