BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items;
DELETE FROM private.trade_revaluation_leagues;
UPDATE private.work_kinds SET last_claimed_at=NULL;
CREATE TEMP TABLE fairness_claims(LIKE private.work_items);
INSERT INTO private.work_items(kind,key,due_at,payload)
  SELECT 'trade-revaluation-check','bulk-check-'||n,now()-interval '6 hours',jsonb_build_object('n',n)
  FROM generate_series(1,330) n;
INSERT INTO private.work_items(kind,key,due_at,payload) VALUES
  ('trade-revaluation-scan','bulk-scan',now()-interval '5 hours','{"scan":true}'),
  ('trade-revaluation','bulk-revalue',now()-interval '4 hours','{"revalue":true}'),
  ('forecast-inputs','bulk-inputs',now()-interval '3 hours','{"schedulerChunk":"forecasts"}'),
  ('notification-scan','bulk-notifications',now()-interval '2 hours','{"schedulerChunk":"notifications"}');
INSERT INTO fairness_claims SELECT * FROM private.work_claim(3);
SELECT pg_temp.check_rules((SELECT count(DISTINCT kind)=3 FROM fairness_claims),
  'one bulk claim rotates background kinds');
SELECT pg_temp.check_rules((SELECT key='bulk-check-1' FROM fairness_claims WHERE kind='trade-revaluation-check'),
  'a check kind starts with its oldest due item');
SELECT pg_temp.check_rules((SELECT count(*)=3 FROM private.work_kinds WHERE last_claimed_at IS NOT NULL),
  'service history records only successful claims');
SELECT pg_temp.check_rules((SELECT kind='trade-revaluation-check' FROM private.work_claim(1)),
  'the fourth slot remains available to an eligible check');
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_claim(4)),
  'fair rotation respects the global four slot limit');
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM private.work_items WHERE status='running' LOOP
    PERFORM private.work_finish(item.id,item.lease_token);
  END LOOP;
END; $$;
DELETE FROM fairness_claims;
INSERT INTO fairness_claims SELECT * FROM private.work_claim(2);
SELECT pg_temp.check_rules((SELECT array_agg(kind ORDER BY kind)=ARRAY['forecast-inputs','notification-scan'] FROM fairness_claims),
  'unserved input and notification kinds receive the next slots');
DELETE FROM private.work_items;
UPDATE private.work_kinds SET last_claimed_at=NULL;
INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,payload)
  SELECT 'stats-sync','reserved-holder-'||n,'running',1,gen_random_uuid(),now()+interval '5 minutes',jsonb_build_object('holder',n)
  FROM generate_series(1,3) n;
INSERT INTO private.work_items(kind,key,due_at,payload)
  SELECT 'forecast-inputs','reserved-input-'||n,now()-interval '6 hours',jsonb_build_object('input',n)
  FROM generate_series(1,128) n;
INSERT INTO private.work_items(kind,key,due_at,payload)
  VALUES('trade-revaluation-check','fourth-slot-check',now(),'{}');
SELECT pg_temp.check_rules((SELECT key='fourth-slot-check' FROM private.work_claim(1)),
  'ineligible input rows do not hide fourth slot work beyond 128 candidates');
SELECT pg_temp.check_rules((SELECT count(*)=128 FROM private.work_items WHERE kind='forecast-inputs' AND attempts=0 AND status='pending'),
  'reserved input rows keep their attempts and pending state');
DELETE FROM private.work_items;
UPDATE private.work_kinds SET last_claimed_at=NULL;
INSERT INTO private.work_items(kind,key,due_at,status,attempts,payload) VALUES
  ('trade-revaluation-check','future-backoff',now()+interval '10 minutes','failed',2,'{"retry":true}'),
  ('notification-scan','due-notifications',now(),'pending',0,'{"notifications":true}');
SELECT pg_temp.check_rules((SELECT key='due-notifications' FROM private.work_claim(1)),
  'fairness does not bypass a future retry deadline');
SELECT pg_temp.check_rules((SELECT status='failed' AND attempts=2 AND due_at>now() FROM private.work_items WHERE key='future-backoff'),
  'a future retry retains its state');
SELECT pg_temp.check_rules(NOT has_table_privilege('authenticated','private.work_kinds','UPDATE'),
  'clients cannot change service history');
SELECT count(*) AS passed FROM rules_checks;
ROLLBACK;
