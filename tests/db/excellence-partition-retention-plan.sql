\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='60s';
DO $$
BEGIN
  IF to_regprocedure('private.ensure_log_partition(regclass,date)') IS NOT NULL THEN
    EXECUTE 'SELECT private.ensure_log_partition(''private.request_receipts'',(now()-interval ''3 months'')::date)';
  END IF;
END;
$$;
INSERT INTO private.request_receipts(request_id,actor,function,result,created_at,input_hash)
SELECT md5('partition-retention-plan-'||n)::uuid,md5('partition-retention-actor')::uuid,
  'partition-retention-plan','{}',date_trunc('month',now())-interval '3 months','same'
FROM generate_series(1,10000) n;
CREATE FUNCTION pg_temp.prune_all_receipts() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE batch bigint; total bigint:=0;
BEGIN
  FOR attempt IN 1..10 LOOP
    batch:=(private.retain_request_receipts()->>'private.request_receipts')::bigint;
    total:=total+batch;
    IF batch=0 THEN RETURN total; END IF;
  END LOOP;
  RAISE EXCEPTION 'Retention does not converge in ten batches';
END;
$$;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT pg_temp.prune_all_receipts();
DO $$
BEGIN
  IF EXISTS(SELECT FROM private.request_receipts WHERE function='partition-retention-plan') THEN
    RAISE EXCEPTION 'Retention leaves expired fixture rows';
  END IF;
END;
$$;
ROLLBACK;
