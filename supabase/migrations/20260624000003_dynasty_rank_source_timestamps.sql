ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS dynasty_rank_source text,
  ADD COLUMN IF NOT EXISTS dynasty_rank_fetched_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_players_dynasty_rank_fetched_at
  ON public.players (dynasty_rank_fetched_at DESC)
  WHERE dynasty_rank IS NOT NULL;

COMMENT ON COLUMN public.players.dynasty_rank_source IS
  'Human-readable source for the current dynasty_rank value.';

COMMENT ON COLUMN public.players.dynasty_rank_fetched_at IS
  'Timestamp when the current dynasty_rank value was fetched from its source.';
