SET lock_timeout='500ms';
SET statement_timeout='30s';
CREATE INDEX edge_invocations_pending ON public.edge_invocations(queued_at,id)
WHERE reconciled_at IS NULL OR worker_status='running';
DROP INDEX public.idx_edge_invocations_unreconciled;
