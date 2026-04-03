-- Add eligible_positions column to players
-- Stores all positions a player qualifies for (from Sleeper fantasy_positions).
-- e.g. ["SF", "PF"] for a forward eligible at both spots, ["PG"] for a pure PG.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS eligible_positions text[] NOT NULL DEFAULT '{}';
