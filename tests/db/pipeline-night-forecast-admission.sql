BEGIN;
\ir rules-support.sql
\ir scheduler-chunk-support.sql
CREATE TEMP TABLE admission_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9634);
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9634,1,current_date,current_date+6);
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
VALUES('002forecast-admission',9634,1,current_date,now()-interval '1 hour','BOS','LAL','InProgress');
CREATE TEMP TABLE forecast_admission AS WITH added AS (
INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
SELECT league_id,season_id,1,member_ids[1],member_ids[2] FROM admission_fixture RETURNING id)
SELECT id AS matchup_id FROM added;
SELECT pg_temp.drain_forecast_chunks();
DELETE FROM private.work_items;
DELETE FROM private.forecast_refresh_requests;
DELETE FROM private.matchup_forecast_expiries;
UPDATE private.matchup_forecast_queue SET dirty=false;
UPDATE private.matchup_forecast_queue SET dirty=true,available_at=now(),claimed_at=NULL WHERE matchup_id=(SELECT matchup_id FROM forecast_admission);
SELECT private.queue_matchup_forecasts(NULL,(SELECT matchup_id FROM forecast_admission));
SELECT private.enqueue_matchup_forecasts();
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='matchup-forecasts'),'blocked inputs do not launch an empty forecast worker');
SELECT pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='forecast-inputs'),'blocked inputs still launch their input worker');
DELETE FROM private.work_items;
DELETE FROM private.forecast_refresh_requests;
SELECT private.enqueue_matchup_forecasts();
SELECT pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='matchup-forecasts'),'ready dirty input wakes the forecast worker');
DELETE FROM private.work_items;
UPDATE private.matchup_forecast_queue SET claimed_at=now() WHERE dirty;
SELECT private.enqueue_matchup_forecasts();
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='matchup-forecasts'),'an active forecast lease suppresses another worker');
UPDATE private.matchup_forecast_queue SET claimed_at=now()-interval '4 minutes' WHERE dirty;
SELECT private.enqueue_matchup_forecasts();
SELECT pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='matchup-forecasts'),'an expired forecast lease remains recoverable');
DELETE FROM private.work_items;
UPDATE private.matchup_forecast_queue SET claimed_at=NULL,input_fingerprint=NULL,computed_fingerprint=NULL WHERE dirty;
SELECT private.queue_matchup_forecasts(NULL,(SELECT matchup_id FROM forecast_admission));
SELECT public.run_scheduler_chunk('forecasts');
SELECT pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='matchup-forecasts'),'finishing an input scope wakes ready computation without another admission scan');
SELECT count(*) AS passed FROM rules_checks;
ROLLBACK;
