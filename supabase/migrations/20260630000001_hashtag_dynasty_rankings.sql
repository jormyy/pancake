CREATE TABLE IF NOT EXISTS public.dynasty_rankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_rank int NOT NULL,
  source_player_id text,
  source_player_name text NOT NULL,
  source_team text,
  source_positions text[] NOT NULL DEFAULT '{}',
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  age numeric(4,1),
  rank_change int NOT NULL DEFAULT 0,
  games_played int,
  field_goal_pct numeric(5,3),
  free_throw_pct numeric(5,3),
  three_pointers_made numeric(5,1),
  points numeric(5,1),
  rebounds numeric(5,1),
  assists numeric(5,1),
  steals numeric(5,1),
  blocks numeric(5,1),
  turnovers numeric(5,1),
  comment text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dynasty_rankings_source_not_blank CHECK (length(trim(source)) > 0),
  CONSTRAINT dynasty_rankings_name_not_blank CHECK (length(trim(source_player_name)) > 0),
  CONSTRAINT dynasty_rankings_rank_positive CHECK (source_rank > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dynasty_rankings_source_rank
  ON public.dynasty_rankings (source, source_rank);

CREATE INDEX IF NOT EXISTS idx_dynasty_rankings_source_player
  ON public.dynasty_rankings (source, source_player_id)
  WHERE source_player_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dynasty_rankings_player
  ON public.dynasty_rankings (player_id, source_rank)
  WHERE player_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dynasty_rankings_fetched_at
  ON public.dynasty_rankings (fetched_at DESC, source_rank);

ALTER TABLE public.dynasty_rankings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dynasty_rankings_select_authenticated ON public.dynasty_rankings;
CREATE POLICY dynasty_rankings_select_authenticated ON public.dynasty_rankings
  FOR SELECT TO authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.dynasty_rankings FROM anon, authenticated;
GRANT SELECT ON public.dynasty_rankings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dynasty_rankings TO service_role;

COMMENT ON TABLE public.dynasty_rankings IS
  'Current source dynasty-ranking rows with source stats/comments. Synced by service-role Edge functions and read by authenticated clients.';
