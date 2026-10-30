BEGIN;
\ir rules-support.sql
SET LOCAL app.supabase_url='http://127.0.0.1:64821';
SET LOCAL app.edge_internal_token='private-pipeline-night';
DELETE FROM private.work_items;
DELETE FROM private.forecast_refresh_requests;
DELETE FROM private.matchup_forecast_expiries;
INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
  SELECT 'matchup:'||id,id,now()-interval '6 hours' FROM public.matchups ORDER BY id LIMIT 82;
UPDATE private.matchup_forecast_queue SET dirty=false,claimed_at=NULL,claim_token=NULL,claimed_revision=NULL;
UPDATE private.matchup_forecast_queue SET dirty=true,available_at=now()-interval '6 hours'
  WHERE matchup_id IN(SELECT matchup_id FROM private.matchup_forecast_queue ORDER BY matchup_id LIMIT 3);
INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
  SELECT 'stats-sync','foreground-holder-'||n,'running',1,gen_random_uuid(),now()+interval '5 minutes',jsonb_build_object('holder',n)
  FROM generate_series(1,2) n;
SELECT private.work_enqueue('forecast-inputs','six-hour-input-backlog',now()-interval '6 hours','{"schedulerChunk":"forecasts"}');
SELECT private.work_enqueue('matchup-forecasts','empty-current-minute',now());
CREATE TEMP TABLE forecast_starvation_claim(LIKE private.work_items);
CREATE TEMP TABLE forecast_starvation_ticks(tick integer,work_item_id bigint,kind text,claimed_forecasts integer);
DO $$
DECLARE selected private.work_items%ROWTYPE; claimed integer;
BEGIN
  FOR tick IN 1..60 LOOP
    SELECT * INTO selected FROM private.work_claim(1);
    IF selected.kind='forecast-inputs' THEN INSERT INTO forecast_starvation_claim SELECT selected.*; EXIT; END IF;
    PERFORM private.work_execute(selected.id,selected.lease_token);
    SELECT count(*) INTO claimed FROM public.claim_matchup_forecasts(10);
    INSERT INTO forecast_starvation_ticks VALUES(tick,selected.id,selected.kind,claimed);
    PERFORM private.work_finish(selected.id,selected.lease_token);
    PERFORM private.work_enqueue('matchup-forecasts','empty-minute-'||tick,now());
  END LOOP;
END;
$$;
SELECT count(*) AS empty_forecast_ticks,sum(claimed_forecasts) AS claimed_forecasts FROM forecast_starvation_ticks;
SELECT jsonb_build_object('overdue_requests',(SELECT count(*) FROM private.forecast_refresh_requests WHERE available_at<=now()),
  'request_timestamps',(SELECT count(DISTINCT available_at) FROM private.forecast_refresh_requests),
  'blocked_dirty',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty AND private.matchup_forecast_refresh_pending(matchup_id)),
  'forecast_invocations',(SELECT count(*) FROM public.edge_invocations WHERE function_name='matchup-forecast' AND work_item_id IN(SELECT work_item_id FROM forecast_starvation_ticks)));
SELECT pg_temp.check_rules((SELECT kind='forecast-inputs' FROM forecast_starvation_claim),
  'overdue input work takes the third slot before an empty forecast worker');
SELECT pg_temp.check_rules((SELECT count(*)=3 FROM private.work_items WHERE status='running'),
  'input recovery leaves the fourth slot available');
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_matchup_forecasts(10)),
  'the skipped forecast worker would have claimed no blocked inputs');
SELECT private.work_enqueue('trade-estimate','urgent-fourth-slot',now()-interval '1 minute','{"urgent":true}');
SELECT pg_temp.check_rules((SELECT kind='trade-estimate' FROM private.work_claim(1)),
  'urgent work still takes the fourth slot ahead of forecast computation');
DELETE FROM private.work_items;
DELETE FROM private.forecast_refresh_requests;
DELETE FROM private.matchup_forecast_expiries;
UPDATE private.matchup_forecast_queue SET dirty=false,claimed_at=NULL,claim_token=NULL,claimed_revision=NULL;
UPDATE private.matchup_forecast_queue SET dirty=true,available_at=now()
  WHERE matchup_id=(SELECT matchup_id FROM private.matchup_forecast_queue ORDER BY matchup_id LIMIT 1);
SELECT private.work_enqueue('trade-revaluation-scan','older-background-scan',now()-interval '6 hours');
SELECT private.work_enqueue('matchup-forecasts','ready-forecast',now());
SELECT pg_temp.check_rules((SELECT kind='matchup-forecasts' FROM private.work_claim(1)),
  'ready forecasts retain priority ahead of an older background scan');
CREATE FUNCTION pg_temp.forecast_priority_choice() RETURNS text LANGUAGE plpgsql AS $$
DECLARE chosen text;
BEGIN
  DELETE FROM private.work_items;
  PERFORM private.work_enqueue('trade-revaluation-scan','older-scan',now()-interval '6 hours');
  PERFORM private.work_enqueue('matchup-forecasts','forecast-choice',now());
  SELECT kind INTO chosen FROM private.work_claim(1);
  RETURN chosen;
END;
$$;
INSERT INTO private.forecast_refresh_requests(scope,matchup_id,available_at)
  SELECT 'matchup:'||matchup_id,matchup_id,now() FROM private.matchup_forecast_queue WHERE NOT dirty ORDER BY matchup_id LIMIT 1;
SELECT pg_temp.check_rules(pg_temp.forecast_priority_choice()='matchup-forecasts','an unrelated pending scope does not demote ready forecast work');
UPDATE private.matchup_forecast_queue SET claimed_at=now() WHERE dirty;
SELECT pg_temp.check_rules(pg_temp.forecast_priority_choice()='trade-revaluation-scan','an active claim does not make another forecast worker ready');
UPDATE private.matchup_forecast_queue SET claimed_at=now()-interval '4 minutes' WHERE dirty;
SELECT pg_temp.check_rules(pg_temp.forecast_priority_choice()='matchup-forecasts','an expired claim restores ready forecast priority');
DELETE FROM private.forecast_refresh_requests;
UPDATE private.matchup_forecast_queue SET dirty=false;
SELECT pg_temp.check_rules(pg_temp.forecast_priority_choice()='matchup-forecasts','an empty forecast without pending inputs can finish normally');
INSERT INTO private.matchup_forecast_expiries(matchup_id,available_at)
  SELECT matchup_id,now() FROM public.matchup_forecasts ORDER BY matchup_id LIMIT 1;
SELECT pg_temp.check_rules(pg_temp.forecast_priority_choice()='trade-revaluation-scan','due expiry work precedes an empty forecast');
SELECT count(*) AS passed FROM rules_checks;
ROLLBACK;
