\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
TRUNCATE public.edge_invocations RESTART IDENTITY;
SELECT private.ensure_log_partition('public.edge_invocations','2001-01-01');
INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,worker_status)
SELECT 'partition-retention-fixture','2001-01-02','2001-01-02',200,'succeeded' FROM generate_series(1,10000);
INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,status_code,worker_status)
VALUES('partition-retention-fixture',now(),now(),200,'succeeded');
ANALYZE public.edge_invocations;
CREATE FUNCTION pg_temp.excellence_retention_cycle() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE removed bigint; total bigint:=0;
BEGIN
  FOR iteration IN 1..5 LOOP
    removed:=(private.retain_edge_invocations(now())->>'public.edge_invocations')::bigint;
    total:=total+removed;
    EXIT WHEN removed=0;
  END LOOP;
  IF total<>10000 OR (SELECT count(*) FROM public.edge_invocations)<>1 THEN
    RAISE EXCEPTION 'Invocation retention does not preserve the newest outcome';
  END IF;
  RETURN total;
END;
$$;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT pg_temp.excellence_retention_cycle();
ROLLBACK;
