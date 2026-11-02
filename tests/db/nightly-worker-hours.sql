\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE invoked_nightly(name text);
CREATE OR REPLACE FUNCTION public.invoke_edge_function(function_name text,body jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO invoked_nightly VALUES(function_name); END; $$;
DO $$
DECLARE item private.work_items%ROWTYPE; name text; at_time timestamptz:='2026-11-03T09:00:00Z';
BEGIN
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002-nightly-worker-hours',9544,1,'2026-11-03',at_time-interval '1 hour','CHI','NYK','InProgress');
  DELETE FROM private.work_items WHERE kind IN ('sync-players','sync-trade-values','sync-rankings');
  PERFORM private.enqueue_scheduled_work(at_time);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-players' AND due_at=at_time),'live games do not prevent nightly player admission');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-trade-values' AND due_at=at_time),'live games do not prevent nightly value admission');
  PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM private.work_items WHERE kind='sync-rankings'),'nightly rankings enter the queue during live games');
  DELETE FROM private.work_items WHERE kind='sync-rankings';
  PERFORM private.enqueue_rankings(at_time-interval '1 minute');
  PERFORM private.enqueue_rankings(at_time+interval '2 hours');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-rankings'),'nightly admission stays within the approved window');
  DELETE FROM private.work_items WHERE kind IN ('sync-players','sync-trade-values','sync-rankings','pick-predictions','trade-revaluation-scan','trade-revaluation-check','trade-revaluation');
  FOREACH name IN ARRAY ARRAY['sync-players','sync-trade-values','sync-rankings','pick-predictions','trade-revaluation-scan','trade-revaluation-check','trade-revaluation'] LOOP
    INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
      VALUES(name,'nightly-hours-'||gen_random_uuid(),'running',2,gen_random_uuid(),now()+interval '5 minutes','{}') RETURNING * INTO item;
    PERFORM private.work_execute(item.id,item.lease_token);
    PERFORM pg_temp.check_rules((SELECT status='running' AND attempts=2 FROM private.work_items WHERE id=item.id),name||' runs without a live-game deferral');
    PERFORM pg_temp.check_rules((SELECT count(*) FROM invoked_nightly)>0,name||' invokes its existing worker');
    DELETE FROM invoked_nightly;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
