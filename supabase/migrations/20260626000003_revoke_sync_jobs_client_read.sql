-- ============================================================
-- Security: remove client read access to the internal sync_jobs ledger
--
-- sync_jobs holds internal sync/backfill bookkeeping — job_type, status,
-- completed/failed counts, and an error_log + metadata jsonb that can contain
-- upstream URLs, stack-ish error strings, and operational detail.
--
-- The original RLS policy `sync_jobs_select USING (true)` exposed every row to
-- ANY authenticated user, even though no client surface reads this table: the
-- backend/Edge read it through the service-role client (which bypasses RLS).
-- Remove the client read surface entirely.
--
-- Idempotent.
-- ============================================================

DROP POLICY IF EXISTS sync_jobs_select ON public.sync_jobs;

-- RLS stays enabled with no policies → deny-all to client roles. Also drop the
-- residual table SELECT grant so the intent is explicit at the grant layer.
REVOKE SELECT ON public.sync_jobs FROM anon, authenticated;

COMMENT ON TABLE public.sync_jobs IS
  'Internal sync/backfill job ledger. No client RLS policies; read only by the '
  'backend/Edge service-role client. error_log/metadata may carry upstream URLs '
  'and operational detail and must never be exposed to anon/authenticated.';
