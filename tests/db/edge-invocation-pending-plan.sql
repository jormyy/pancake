BEGIN;
\ir rules-support.sql
SET LOCAL session_replication_role=replica;
INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,worker_status,status_code)
SELECT 'pending-plan-fixture',now(),now(),'success',200 FROM generate_series(1,5000);
SET LOCAL session_replication_role=origin;
UPDATE public.edge_invocations SET reconciled_at=coalesce(reconciled_at,now()),worker_status='success'
WHERE reconciled_at IS NULL OR worker_status='running';
ANALYZE public.edge_invocations;
DO $$
DECLARE plan jsonb; buffers bigint; bound bigint; invocation bigint;
BEGIN
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT EXISTS(SELECT 1 FROM public.edge_invocations WHERE reconciled_at IS NULL OR worker_status=''running'')' INTO plan;
  buffers:=coalesce((plan->0->'Plan'->>'Shared Hit Blocks')::bigint,0)+coalesce((plan->0->'Plan'->>'Shared Read Blocks')::bigint,0);
  SELECT greatest(64,count(*)*4) INTO bound FROM pg_partition_tree('public.edge_invocations') WHERE isleaf;
  PERFORM pg_temp.check_rules(buffers<=bound,'idle dispatch scans bounded index pages instead of completed invocation history');
  INSERT INTO public.edge_invocations(function_name,worker_status) VALUES('pending-plan-fixture','pending') RETURNING id INTO invocation;
  PERFORM pg_temp.check_rules(EXISTS(SELECT FROM public.edge_invocations WHERE reconciled_at IS NULL OR worker_status='running'),'unreconciled work remains visible');
  UPDATE public.edge_invocations SET reconciled_at=now(),worker_status='running' WHERE id=invocation;
  PERFORM pg_temp.check_rules(EXISTS(SELECT FROM public.edge_invocations WHERE reconciled_at IS NULL OR worker_status='running'),'a reconciled running worker remains visible');
  UPDATE public.edge_invocations SET worker_status='success' WHERE id=invocation;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM public.edge_invocations WHERE reconciled_at IS NULL OR worker_status='running'),'completed invocations leave the pending set');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
