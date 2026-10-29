\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='500ms';
SET LOCAL jit=off;
SELECT jsonb_build_object(
  'edge_invocations',(SELECT md5(coalesce(string_agg(md5(to_jsonb(row)::text),'' ORDER BY id),'')) FROM public.edge_invocations row),
  'league_events',(SELECT md5(coalesce(string_agg(md5(to_jsonb(row)::text),'' ORDER BY id),'')) FROM public.league_events row));
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT id,function_name,worker_status,queued_at FROM public.edge_invocations
WHERE reconciled_at IS NULL OR worker_status='running' ORDER BY queued_at,id LIMIT 100;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT id,league_id,kind,summary,created_at FROM public.league_events
WHERE created_at>now()-interval '7 days' ORDER BY created_at DESC,id DESC LIMIT 100;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
SELECT private.retain_edge_invocations(now());
ROLLBACK;
