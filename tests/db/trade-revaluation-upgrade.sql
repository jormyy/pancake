BEGIN;
\ir rules-support.sql
\ir perf-l4-trade-batch-fixture.sql
DELETE FROM private.work_items WHERE kind IN ('trade-revaluation-check','trade-revaluation-scan') AND status IN ('pending','failed');
SELECT pg_temp.l4_batch_fixture(10,true);
CREATE TEMP TABLE l4_upgrade_snapshot AS SELECT * FROM private.work_items WHERE false;
CREATE TEMP TABLE l4_upgrade_state(oldest_scan bigint,first_due timestamptz);
CREATE TEMP TABLE l4_upgrade_attempts AS SELECT id,attempts,invocation_key,last_error FROM private.work_items WHERE false;
CREATE FUNCTION pg_temp.l4_upgrade_seed() RETURNS void LANGUAGE plpgsql AS $$
DECLARE f record; first_due timestamptz:=date_trunc('day',now())+interval '5 hours 33 minutes 2 seconds';
  oldest_scan bigint;
BEGIN
  SELECT * INTO f FROM l4_batch_context;
  UPDATE private.screen_refresh_queue SET version=1000 WHERE league_season_id=f.season_id;
  DELETE FROM private.trade_value_publications WHERE trade_id=ANY(f.trade_ids[1:8]);
  PERFORM private.refresh_queue_trade_revaluation(trade.id,private.trade_revaluation_input_version(trade.id),'batch-fixture')
    FROM unnest(f.trade_ids[1:8]) trade(id);
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    SELECT 'trade-revaluation-check','upgrade-check:'||f.league_id::text||':'||n,first_due+(n-1)*interval '1 second',
      jsonb_build_object('checkInputs',true,'tradeId',f.trade_ids[1+(n-1)%10],'version',n),f.league_id FROM generate_series(1,330) n;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    SELECT 'trade-revaluation-scan','upgrade-scan:'||f.league_id::text||':'||n,first_due+(n-1)*interval '1 minute',
      jsonb_build_object('revaluationScan',true,'seasonId',f.season_id,'leagueId',f.league_id,'version',n,
        'after',f.trade_ids[5]),f.league_id FROM generate_series(1,41) n;
  SELECT id INTO oldest_scan FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-scan' ORDER BY due_at,id LIMIT 1;
  INSERT INTO l4_upgrade_snapshot SELECT * FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation';
  PERFORM pg_temp.check_rules((SELECT count(*)=330 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-check' AND status='pending'),
    'upgrade starts with 330 pending checks');
  PERFORM pg_temp.check_rules((SELECT count(*)=41 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-scan' AND status='pending'),
    'upgrade starts with 41 pending scans');
  PERFORM pg_temp.check_rules((SELECT count(*)=8 AND bool_and(status='pending') FROM l4_upgrade_snapshot),'upgrade starts with eight pending revaluations');
  INSERT INTO private.work_items(kind,key,status,attempts,invocation_key,last_error,payload,league_id)
    VALUES('trade-revaluation-check','upgrade-failed-check:'||f.league_id::text,'failed',2,gen_random_uuid(),'Existing worker failure',
      jsonb_build_object('checkInputs',true,'tradeId',f.trade_ids[1],'version',99998),f.league_id),
      ('trade-revaluation-scan','upgrade-failed-scan:'||f.league_id::text,'failed',2,gen_random_uuid(),'Existing scan failure',
        jsonb_build_object('revaluationScan',true,'seasonId',f.season_id,'version',99998),f.league_id);
  INSERT INTO l4_upgrade_snapshot SELECT * FROM private.work_items WHERE league_id=f.league_id AND status='failed';
  UPDATE private.work_items SET attempts=1,invocation_key=gen_random_uuid(),last_error='Earlier failed attempt'
    WHERE league_id=f.league_id AND (id=oldest_scan OR (kind='trade-revaluation-check' AND status='pending' AND (payload->>'version')::integer%10=0));
  INSERT INTO l4_upgrade_attempts SELECT id,attempts,invocation_key,last_error FROM private.work_items
    WHERE league_id=f.league_id AND status='pending' AND attempts>0;
  INSERT INTO l4_upgrade_state VALUES(oldest_scan,first_due);
END $$;
CREATE FUNCTION pg_temp.l4_upgrade_verify() RETURNS void LANGUAGE plpgsql AS $$
DECLARE f record; first_due timestamptz; oldest_scan bigint; result jsonb; before_repeat jsonb; kept_payload jsonb; missing_work bigint;
BEGIN
  SELECT * INTO f FROM l4_batch_context;
  SELECT state.oldest_scan,state.first_due INTO oldest_scan,first_due FROM l4_upgrade_state state;
  PERFORM pg_temp.check_rules((SELECT count(*)=370 FROM private.work_items WHERE league_id=f.league_id AND status='succeeded'
    AND payload->>'supersededBy'='league-wide scan'),'upgrade supersedes 330 checks and forty duplicate scans');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-check' AND status='pending'),
    'upgrade leaves no pending legacy check');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-scan' AND status='pending'),
    'upgrade leaves one pending scan');
  PERFORM pg_temp.check_rules((SELECT id=oldest_scan AND due_at=first_due AND NOT payload ? 'after' FROM private.work_items WHERE id=oldest_scan),
    'upgrade retains the oldest scan and removes its continuation cursor');
  PERFORM pg_temp.check_rules(NOT private.enqueue_trade_revaluation_scan(f.season_id,1000,'batch-fixture'),
    'refresh completion cannot duplicate the pending replacement scan');
  PERFORM pg_temp.check_rules(NOT EXISTS((SELECT * FROM l4_upgrade_snapshot EXCEPT SELECT * FROM private.work_items)
    UNION ALL (SELECT * FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation' EXCEPT SELECT * FROM l4_upgrade_snapshot)),
    'upgrade preserves all eight revaluation rows byte for byte');
  PERFORM pg_temp.check_rules((SELECT count(*)=34 FROM l4_upgrade_attempts)
    AND NOT EXISTS(SELECT * FROM l4_upgrade_attempts EXCEPT SELECT id,attempts,invocation_key,last_error FROM private.work_items),
    'upgrade preserves earlier failed-attempt evidence on pending rows');
  SELECT jsonb_agg(to_jsonb(item) ORDER BY id) INTO before_repeat FROM private.work_items item WHERE league_id=f.league_id;
  result:=private.coalesce_trade_revaluation_work();
  PERFORM pg_temp.check_rules(result->>'superseded'='0' AND before_repeat=(SELECT jsonb_agg(to_jsonb(item) ORDER BY id)
    FROM private.work_items item WHERE league_id=f.league_id),'applying cleanup again is a byte-identical no-op');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT * FROM l4_upgrade_snapshot EXCEPT SELECT * FROM private.work_items),
    'upgrade preserves failed attempts, errors, and invocation links');
  SELECT payload INTO kept_payload FROM private.work_items WHERE id=oldest_scan;
  PERFORM private.refresh_queue_trade_revaluations(f.season_id,(kept_payload->>'version')::bigint,'batch-fixture');
  PERFORM pg_temp.check_rules((SELECT count(*)=8 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation'),
    'the replacement scan creates no duplicate revaluations');
  PERFORM pg_temp.check_rules((SELECT count(*)=8 AND bool_and(payload->>'inputFingerprint'=private.trade_revaluation_input_version((payload->>'tradeId')::uuid))
    FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation'),'the replacement scan covers current fingerprints');
  UPDATE private.work_items SET status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes' WHERE id=oldest_scan;
  INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,payload,league_id)
    VALUES('trade-revaluation-check','upgrade-running-check:'||f.league_id::text,'running',gen_random_uuid(),now()+interval '5 minutes',
      jsonb_build_object('checkInputs',true,'tradeId',f.trade_ids[1],'version',99999),f.league_id),
      ('trade-estimate','upgrade-foreground:'||f.league_id::text,'running',gen_random_uuid(),now()+interval '5 minutes','{"request":"foreground"}',f.league_id);
  DELETE FROM l4_upgrade_snapshot;
  INSERT INTO l4_upgrade_snapshot SELECT * FROM private.work_items WHERE league_id=f.league_id AND (status='running' OR kind='trade-revaluation');
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    VALUES('trade-revaluation-check','upgrade-late-check:'||f.league_id::text,first_due,jsonb_build_object('checkInputs',true,'tradeId',f.trade_ids[1]),f.league_id);
  PERFORM private.coalesce_trade_revaluation_work();
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-scan' AND status='pending'),
    'a check arriving between migrations gets a successor behind a running scan');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT * FROM l4_upgrade_snapshot EXCEPT SELECT * FROM private.work_items),
    'upgrade does not alter running checks, scans, foreground work, or existing revaluations');
  UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=oldest_scan;
  UPDATE private.work_items SET status='succeeded',completed_at=now() WHERE league_id=f.league_id AND kind='trade-revaluation-scan' AND status='pending';
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    VALUES('trade-revaluation-check','upgrade-check-without-scan:'||f.league_id::text,first_due,jsonb_build_object('checkInputs',true,'tradeId',f.trade_ids[2]),f.league_id);
  PERFORM private.coalesce_trade_revaluation_work();
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE league_id=f.league_id AND kind='trade-revaluation-scan' AND status='pending'),
    'checks without an existing scan get a full replacement scan');
  UPDATE public.trades SET status='completed' WHERE league_season_id=f.season_id;
  INSERT INTO private.work_items(kind,key,payload,league_id) VALUES('trade-revaluation-check','upgrade-missing-trade:'||f.league_id::text,
    jsonb_build_object('checkInputs',true,'tradeId',gen_random_uuid()),f.league_id) RETURNING id INTO missing_work;
  PERFORM private.coalesce_trade_revaluation_work();
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE league_id=f.league_id
    AND kind IN ('trade-revaluation-check','trade-revaluation-scan') AND status='pending'),
    'closed and missing trades leave no orphan pending check or scan');
  PERFORM pg_temp.check_rules((SELECT status='succeeded' AND payload->>'supersededBy'='no open trades' FROM private.work_items WHERE id=missing_work),
    'orphan cleanup records why the check is superseded');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('service_role','private.coalesce_trade_revaluation_work()','EXECUTE'),
    'the migration helper is unavailable to workers and clients');
END $$;
SELECT pg_temp.l4_upgrade_seed();
SELECT private.coalesce_trade_revaluation_work();
SELECT pg_temp.l4_upgrade_verify();
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
