BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE source_injury_dispatches(job text,name text,body jsonb);
CREATE OR REPLACE FUNCTION private.invoke_claimed_edge_function(p_job_key text,p_function_name text,p_body jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$ INSERT INTO source_injury_dispatches VALUES(p_job_key,p_function_name,p_body); $$;
DO $$
DECLARE v_day date:=date '9542-01-03';
BEGIN
  DELETE FROM nba_games WHERE game_date=v_day;
  PERFORM invoke_player_injuries_if_due((v_day+time '08:00') AT TIME ZONE 'America/New_York');
  PERFORM invoke_player_injuries_if_due((v_day+time '08:15') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM source_injury_dispatches),'No-game day refreshes once each hour');
  PERFORM invoke_player_injuries_if_due((v_day+time '09:00') AT TIME ZONE 'America/New_York');
  PERFORM invoke_player_injuries_if_due((v_day+time '23:00') AT TIME ZONE 'America/New_York');
  PERFORM invoke_player_injuries_if_due((v_day+time '01:00') AT TIME ZONE 'America/New_York');
  PERFORM invoke_player_injuries_if_due((v_day+time '02:00') AT TIME ZONE 'America/New_York');
  PERFORM invoke_player_injuries_if_due((v_day+time '03:00') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=5 FROM source_injury_dispatches),'Off-day and overnight hours remain covered');
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES('002sourcehours',9542,1,v_day,'BOS','MIN','Scheduled',(v_day+time '22:00') AT TIME ZONE 'America/New_York');
  PERFORM invoke_player_injuries_if_due((v_day+time '11:00') AT TIME ZONE 'America/New_York');
  PERFORM invoke_player_injuries_if_due((v_day+time '11:15') AT TIME ZONE 'America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=7 FROM source_injury_dispatches),'Game-day quarter-hour cadence is retained');
END $$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
