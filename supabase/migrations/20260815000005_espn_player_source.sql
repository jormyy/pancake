-- Keyless player-source migration: ESPN athlete IDs live alongside the
-- existing sleeper_id (additive mapping, never a destructive re-key).
-- Existing sleeper-keyed player IDs keep resolving unchanged.

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS espn_id text;

ALTER TABLE public.players
  ADD CONSTRAINT players_espn_id_key UNIQUE (espn_id);
