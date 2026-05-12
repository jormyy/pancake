-- Preserve the exact future-pick asset consumed by each rookie draft slot.
--
-- Finding:
-- - P1-21: snake draft completion marked an arbitrary unused draft_picks row
--   by current owner + round, which can consume the wrong asset when a team owns
--   multiple same-round picks.

ALTER TABLE snake_draft_picks
  ADD COLUMN IF NOT EXISTS draft_pick_id uuid REFERENCES draft_picks(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_snake_draft_picks_draft_pick_id
  ON snake_draft_picks(draft_pick_id)
  WHERE draft_pick_id IS NOT NULL;
