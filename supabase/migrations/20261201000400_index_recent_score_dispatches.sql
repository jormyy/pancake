SET lock_timeout='500ms';
SET statement_timeout='30s';
CREATE INDEX edge_invocations_recent_scores ON public.edge_invocations(queued_at DESC)
WHERE function_name='sync-scores';
