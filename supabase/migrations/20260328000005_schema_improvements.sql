-- ============================================================
-- Migration: Schema Improvements
--
-- 1. pg_jsonschema validation on leagues.scoring_settings
-- 2. Missing FK/query indexes
-- 3. Denormalize league_id onto bids (for faster RLS evaluation)
-- ============================================================

-- ── 1. pg_jsonschema: validate scoring_settings ───────────────
-- Prevents typos like "poitns" and ensures all values are numeric.
-- Only stat keys used by compute_fantasy_points() are allowed.
-- Negative values (turnovers: -1.0) are valid JSON numbers.

CREATE EXTENSION IF NOT EXISTS pg_jsonschema;

ALTER TABLE leagues
  ADD CONSTRAINT scoring_settings_schema CHECK (
    jsonb_matches_schema(
      '{
        "type": "object",
        "additionalProperties": { "type": "number" },
        "propertyNames": {
          "enum": [
            "points", "rebounds", "assists", "steals", "blocks",
            "turnovers", "three_pointers_made", "double_double",
            "triple_double", "offensive_rebounds", "defensive_rebounds",
            "field_goals_made", "field_goals_attempted",
            "free_throws_made", "free_throws_attempted",
            "personal_fouls", "minutes_played", "plus_minus"
          ]
        }
      }',
      scoring_settings
    )
  );

-- ── 2. Missing indexes ────────────────────────────────────────

-- waiver_claims: league_id + league_season_id is a common WHERE clause
-- (e.g. "show all claims in this league this season")
CREATE INDEX IF NOT EXISTS idx_waiver_claims_league_season
  ON waiver_claims(league_id, league_season_id);

-- waiver_wire_log: same pattern — filtered by league + season
CREATE INDEX IF NOT EXISTS idx_waiver_wire_log_league_season
  ON waiver_wire_log(league_id, league_season_id);

-- weekly_lineups: covers the full scoring join path used in syncScores()
-- (member, league, season, week → player_id for all non-bench slots)
CREATE INDEX IF NOT EXISTS idx_lineups_scoring_path
  ON weekly_lineups(league_id, league_season_id, week_number, member_id, player_id);

-- draft_picks: queried by current_owner_id per league during trades
CREATE INDEX IF NOT EXISTS idx_draft_picks_league_owner
  ON draft_picks(league_id, current_owner_id);

-- ── 3. Denormalize league_id onto bids ────────────────────────
-- The RLS policy on `bids` currently requires a 3-level join:
--   bids → nominations → drafts → league_id
-- Adding league_id directly flattens this to a single lookup.
-- The trigger below keeps it in sync automatically on INSERT.

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS league_id uuid REFERENCES leagues(id);

-- Backfill existing rows
UPDATE bids b
SET    league_id = d.league_id
FROM   nominations n
JOIN   drafts      d ON d.id = n.draft_id
WHERE  n.id = b.nomination_id
  AND  b.league_id IS NULL;

-- Auto-populate league_id on every new bid
CREATE OR REPLACE FUNCTION set_bid_league_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT d.league_id
  INTO   NEW.league_id
  FROM   nominations n
  JOIN   drafts d ON d.id = n.draft_id
  WHERE  n.id = NEW.nomination_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bid_league_id
  BEFORE INSERT ON bids
  FOR EACH ROW EXECUTE FUNCTION set_bid_league_id();

CREATE INDEX IF NOT EXISTS idx_bids_league
  ON bids(league_id);

-- Replace the slow 3-level-join RLS policy on bids with a direct lookup
DROP POLICY IF EXISTS "bids_select" ON bids;

CREATE POLICY "bids_select" ON bids
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));
