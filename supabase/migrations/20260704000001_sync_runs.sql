-- Generic run monitoring for scheduled Edge sync functions
-- (sync-scores, sync-stats, sync-players, sync-schedule, sync-rankings).
-- projection_sync_runs already instruments sync-projections; this table is the
-- lightweight equivalent for the remaining crons. Backend-only: recorded and
-- read through the service role.

CREATE TABLE IF NOT EXISTS public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  rows_affected int,
  error text
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_function_started
  ON public.sync_runs (function_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status_started
  ON public.sync_runs (status, started_at DESC);

ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sync_runs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sync_runs TO service_role;
