\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
\ir rules-support.sql
DELETE FROM public.edge_invocations WHERE function_name='sync-scores' AND queued_at>=now()-interval '30 minutes';
SET LOCAL session_replication_role=replica;
INSERT INTO public.edge_invocations(function_name,queued_at,reconciled_at,worker_status)
SELECT 'score-dispatch-other',now()-interval '1 minute',now(),'success' FROM generate_series(1,5000);
SET LOCAL session_replication_role=origin;
DO $$
DECLARE plan jsonb;
BEGIN
  EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT EXISTS(SELECT 1 FROM public.edge_invocations WHERE function_name=''sync-scores'' AND queued_at>now()-interval ''30 minutes'')' INTO plan;
  PERFORM pg_temp.check_rules(coalesce((plan->0->'Plan'->>'Shared Hit Blocks')::int,0)
    +coalesce((plan->0->'Plan'->>'Shared Read Blocks')::int,0)<=20,'an idle score check has a bounded buffer cost');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM public.edge_invocations
    WHERE function_name='sync-scores' AND queued_at>now()-interval '30 minutes'),'unrelated workers do not suppress scoring');
  INSERT INTO public.edge_invocations(function_name,queued_at) VALUES('sync-scores',now()-interval '30 minutes');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT FROM public.edge_invocations
    WHERE function_name='sync-scores' AND queued_at>now()-interval '30 minutes'),'the exact cooldown boundary permits scoring');
  INSERT INTO public.edge_invocations(function_name,queued_at) VALUES('sync-scores',now()-interval '29 minutes');
  PERFORM pg_temp.check_rules(EXISTS(SELECT FROM public.edge_invocations
    WHERE function_name='sync-scores' AND queued_at>now()-interval '30 minutes'),'a recent score invocation retains the cooldown');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
