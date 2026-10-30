BEGIN;
\ir rules-support.sql
\ir perf-l4-trade-batch-fixture.sql
SELECT pg_temp.l4_batch_fixture(10,true);
DO $$
DECLARE f record; v_trade uuid; v_work bigint; v_version bigint;
BEGIN
  SELECT * INTO f FROM l4_batch_context;
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,1,'batch-fixture');
  PERFORM pg_temp.check_rules(NOT private.enqueue_trade_revaluation_scan(f.season_id,2,'batch-fixture'),
    'unchanged sources create no scan');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE league_id=f.league_id),
    'unchanged sources create no follow-up worker');
  UPDATE private.screen_refresh_queue SET version=version+1 WHERE league_season_id=f.season_id RETURNING version INTO v_version;
  PERFORM pg_temp.check_rules(NOT private.enqueue_trade_revaluation_scan(f.season_id,3,'batch-fixture'),
    'a screen version alone creates no scan');
  PERFORM pg_temp.check_rules((SELECT bool_and(version=v_version) FROM private.trade_value_publications WHERE trade_id=ANY(f.trade_ids)),
    'matching publications advance freshness without a scan');
  PERFORM pg_temp.check_rules(private.enqueue_trade_revaluation_scan(f.season_id,4,'changed-model'),
    'a changed model creates a scan');
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,4,'changed-model');
  PERFORM pg_temp.check_rules(NOT private.enqueue_trade_revaluation_scan(f.season_id,5,'changed-model'),
    'already queued matching valuations need no second scan');
  v_trade:=f.trade_ids[1];
  SELECT id INTO v_work FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation'
    AND payload->>'tradeId'=v_trade::text;
  UPDATE private.work_items SET status='dead' WHERE id=v_work;
  PERFORM pg_temp.check_rules(private.enqueue_trade_revaluation_scan(f.season_id,6,'changed-model'),
    'dead unpublished work remains recoverable');
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,6,'changed-model');
  UPDATE private.work_items SET status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes' WHERE id=v_work;
  UPDATE public.trade_items SET faab_amount=faab_amount+1 WHERE trade_id=v_trade AND faab_amount>0;
  PERFORM pg_temp.check_rules(private.enqueue_trade_revaluation_scan(f.season_id,7,'changed-model'),
    'changed sources create a scan');
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,7,'changed-model');
  PERFORM pg_temp.check_rules(private.enqueue_trade_revaluation_scan(f.season_id,8,'changed-model'),
    'a running older fingerprint cannot suppress its successor');
  UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=v_work;
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,8,'changed-model');
  PERFORM pg_temp.check_rules((SELECT status='pending' AND payload->>'inputFingerprint'=private.trade_revaluation_input_version(v_trade)
    FROM private.work_items WHERE id=v_work),'the successor uses the current fingerprint');
  PERFORM pg_temp.check_rules(NOT private.enqueue_trade_revaluation_scan(f.season_id,9,'changed-model'),
    'a queued successor restores the unchanged-source gate');
  UPDATE private.trade_revaluation_scans SET next_change_at=now()-interval '1 second' WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules(private.enqueue_trade_revaluation_scan(f.season_id,10,'changed-model'),
    'a temporal fingerprint deadline opens the gate');
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,10,'changed-model');
  PERFORM pg_temp.check_rules(private.enqueue_trade_revaluation_scan(f.season_id,11),
    'older workers without a model remain compatible');
  UPDATE public.trades SET status='completed' WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules(NOT private.enqueue_trade_revaluation_scan(f.season_id,12,'changed-model'),
    'a league without open trades creates no scan');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.trade_revaluation_scans WHERE league_season_id=f.season_id),
    'closing the last trade removes scan state');
  PERFORM pg_temp.check_rules(NOT private.enqueue_trade_revaluation_scan(gen_random_uuid(),13,'changed-model'),
    'a missing season creates no scan');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('service_role','private.trade_revaluation_scans','SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_function_privilege('authenticated','private.enqueue_trade_revaluation_scan(uuid,bigint,text)','EXECUTE'),
    'clients cannot inspect or alter the scan gate');
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
