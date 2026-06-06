CREATE TABLE IF NOT EXISTS public.backfill_game_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.sync_jobs(id) ON DELETE CASCADE,
  source text NOT NULL,
  season_year int NOT NULL,
  game_key text NOT NULL,
  game_db_id uuid REFERENCES public.nba_games(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  attempts int NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, source, game_key)
);

CREATE INDEX IF NOT EXISTS idx_backfill_game_attempts_job_source_status
  ON public.backfill_game_attempts(job_id, source, status);

REVOKE ALL ON TABLE public.backfill_game_attempts FROM anon;
REVOKE ALL ON TABLE public.backfill_game_attempts FROM authenticated;
GRANT ALL ON TABLE public.backfill_game_attempts TO service_role;
