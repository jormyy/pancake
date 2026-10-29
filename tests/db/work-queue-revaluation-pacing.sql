\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
DELETE FROM private.trade_revaluation_leagues;
DO $$
DECLARE f record; other record; row record; ids bigint[]; one bigint; token uuid; claimed text[]; v_kind text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9593);
  SELECT * INTO other FROM pg_temp.rules_fixture(2,9594);
  FOR n IN 1..22 LOOP
    PERFORM private.work_enqueue('trade-revaluation','burst-'||n,now()-interval '1 hour',jsonb_build_object('trade',n),f.league_id);
  END LOOP;
  FOREACH v_kind IN ARRAY ARRAY['process-waivers','process-trades','live-poll'] LOOP
    PERFORM private.work_enqueue(v_kind,'critical-'||v_kind,now(),'{}',f.league_id);
  END LOOP;
  SELECT array_agg(kind ORDER BY kind) INTO claimed FROM private.work_claim(3);
  PERFORM pg_temp.check_rules(claimed=ARRAY['live-poll','process-trades','process-waivers'],
    'urgent work passes the older revaluation burst');
  SELECT id,lease_token INTO one,token FROM private.work_claim(4);
  PERFORM pg_temp.check_rules(one IS NOT NULL,'one background revaluation fills the remaining slot');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='trade-revaluation' AND status='running'),
    'one league has at most one revaluation in flight');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_claim(4)),
    'the global four-worker budget remains bounded');
  FOR row IN SELECT id,lease_token FROM private.work_items WHERE status='running' LOOP
    PERFORM private.work_finish(row.id,row.lease_token);
  END LOOP;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_claim(4)),
    'a completed revaluation does not release another call in the same minute');
  UPDATE private.work_items SET status='pending',completed_at=NULL,due_at=now() WHERE id=one;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_claim(4)),
    'coalescing a newer input version keeps the league pace');
  UPDATE private.trade_revaluation_leagues SET next_allowed_at=now()-interval '1 second' WHERE league_id=f.league_id;
  SELECT array_agg(id) INTO ids FROM private.work_claim(4);
  PERFORM pg_temp.check_rules(cardinality(ids)=1,'the next eligible minute admits exactly one revaluation');
  DELETE FROM private.work_items;
  DELETE FROM private.trade_revaluation_leagues;
  PERFORM private.work_enqueue('trade-revaluation','league-one-a',now(),'{}',f.league_id);
  PERFORM private.work_enqueue('trade-revaluation','league-one-b',now(),'{"next":true}',f.league_id);
  PERFORM private.work_enqueue('trade-revaluation','league-two',now(),'{"other":true}',other.league_id);
  SELECT array_agg(id) INTO ids FROM private.work_claim(4);
  PERFORM pg_temp.check_rules(cardinality(ids)=2,'different leagues can each make progress');
  PERFORM pg_temp.check_rules((SELECT count(DISTINCT league_id)=2 FROM private.work_items WHERE status='running'),
    'parallel revaluations belong to different leagues');
  UPDATE private.work_items SET lease_until=now()-interval '1 second' WHERE status='running';
  PERFORM private.work_claim(0);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE status='failed' AND last_error='Worker lease expired'),
    'the claim gate still recovers expired leases');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','private.trade_revaluation_leagues','INSERT,UPDATE,DELETE'),
    'clients cannot alter the background pace');
  DELETE FROM private.work_items;
  DELETE FROM private.trade_revaluation_leagues;
  FOR n IN 1..22 LOOP
    PERFORM private.work_enqueue('trade-revaluation','foreground-burst-'||n,now()-interval '1 hour',jsonb_build_object('trade',n),f.league_id);
  END LOOP;
  PERFORM private.work_enqueue('trade-estimate','foreground-estimate',now(),'{"tradeId":"00000000-0000-0000-0000-000000000001"}',f.league_id);
  SELECT array_agg(kind) INTO claimed FROM private.work_claim(1);
  PERFORM pg_temp.check_rules(claimed=ARRAY['trade-estimate'],
    'a foreground trade estimate is claimed ahead of older eligible background revaluations');
  SELECT id,lease_token INTO one,token FROM private.work_items WHERE key='foreground-estimate';
  PERFORM private.work_finish(one,token);
  INSERT INTO private.trade_revaluation_leagues(league_id,next_allowed_at)
    VALUES(f.league_id,now()+interval '1 minute');
  PERFORM private.work_enqueue('trade-estimate','foreground-during-pace',now(),'{}',f.league_id);
  SELECT array_agg(kind) INTO claimed FROM private.work_claim(1);
  PERFORM pg_temp.check_rules(claimed=ARRAY['trade-estimate'],
    'a foreground trade estimate bypasses an active background league pace');
  PERFORM pg_temp.check_rules((SELECT count(*)=22 FROM private.work_items WHERE kind='trade-revaluation' AND status='pending'),
    'foreground claims preserve the queued background revaluations');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_claim(4)),
    'the foreground request does not bypass the background league pace');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
