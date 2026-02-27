-- ============================================================
-- Migration 003: Functions & Triggers
-- Dynasty Fantasy Basketball App
-- ============================================================

-- ============================================================
-- updated_at trigger
-- Automatically keeps updated_at current on any row update.
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_leagues_updated_at
  BEFORE UPDATE ON leagues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_players_updated_at
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_nba_games_updated_at
  BEFORE UPDATE ON nba_games
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_player_game_stats_updated_at
  BEFORE UPDATE ON player_game_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Default lineup slot template
-- Seeded automatically when a new league is created.
--
-- Default layout (22 total = 20 active + 2 IR):
--   Starters (10): PG×1, SG×1, SF×1, PF×1, C×1, G×1, F×1, UTIL×3
--   Bench    (10): BE×10
--   IR        (2): IR×2
-- ============================================================

CREATE OR REPLACE FUNCTION seed_default_lineup_slots()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lineup_slot_templates (league_id, slot_type, slot_count)
  VALUES
    (NEW.id, 'PG',   1),
    (NEW.id, 'SG',   1),
    (NEW.id, 'SF',   1),
    (NEW.id, 'PF',   1),
    (NEW.id, 'C',    1),
    (NEW.id, 'G',    1),
    (NEW.id, 'F',    1),
    (NEW.id, 'UTIL', 3),
    (NEW.id, 'BE',   10),
    (NEW.id, 'IR',   2);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_seed_lineup_slots
  AFTER INSERT ON leagues
  FOR EACH ROW EXECUTE FUNCTION seed_default_lineup_slots();

-- ============================================================
-- Default scoring settings
-- Applied when a new league is created (via trigger).
-- Commissioners can override any value after creation.
--
-- Default values (ESPN-inspired):
--   points            +1.0
--   rebounds          +1.2
--   assists           +1.5
--   steals            +3.0
--   blocks            +3.0
--   turnovers         -1.0
--   three_pointers_made +0.5
--   double_double     +1.5  (bonus)
--   triple_double     +3.0  (bonus)
-- ============================================================

CREATE OR REPLACE FUNCTION seed_default_scoring_settings()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only apply defaults if the commissioner left scoring_settings empty
  IF NEW.scoring_settings = '{}' THEN
    NEW.scoring_settings = '{
      "points": 1.0,
      "rebounds": 1.2,
      "assists": 1.5,
      "steals": 3.0,
      "blocks": 3.0,
      "turnovers": -1.0,
      "three_pointers_made": 0.5,
      "double_double": 1.5,
      "triple_double": 3.0
    }'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_seed_scoring_settings
  BEFORE INSERT ON leagues
  FOR EACH ROW EXECUTE FUNCTION seed_default_scoring_settings();

-- ============================================================
-- Compute fantasy points for a player in a given league
-- Usage: SELECT compute_fantasy_points(<player_game_stats_id>, <league_id>)
--
-- Returns the total fantasy points for that game line
-- under that league's scoring settings.
-- ============================================================

CREATE OR REPLACE FUNCTION compute_fantasy_points(
  p_stat_id   uuid,
  p_league_id uuid
)
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_settings jsonb;
  v_stats    player_game_stats%ROWTYPE;
  v_total    numeric := 0;
BEGIN
  SELECT scoring_settings INTO v_settings
    FROM leagues WHERE id = p_league_id;

  SELECT * INTO v_stats
    FROM player_game_stats WHERE id = p_stat_id;

  IF v_stats.did_not_play THEN
    RETURN 0;
  END IF;

  v_total :=
    COALESCE(v_stats.points,               0) * COALESCE((v_settings->>'points')::numeric,             0) +
    COALESCE(v_stats.rebounds,             0) * COALESCE((v_settings->>'rebounds')::numeric,           0) +
    COALESCE(v_stats.assists,              0) * COALESCE((v_settings->>'assists')::numeric,             0) +
    COALESCE(v_stats.steals,               0) * COALESCE((v_settings->>'steals')::numeric,             0) +
    COALESCE(v_stats.blocks,               0) * COALESCE((v_settings->>'blocks')::numeric,             0) +
    COALESCE(v_stats.turnovers,            0) * COALESCE((v_settings->>'turnovers')::numeric,          0) +
    COALESCE(v_stats.three_pointers_made,  0) * COALESCE((v_settings->>'three_pointers_made')::numeric,0) +
    CASE WHEN v_stats.double_double = true
      THEN COALESCE((v_settings->>'double_double')::numeric, 0) ELSE 0 END +
    CASE WHEN v_stats.triple_double = true
      THEN COALESCE((v_settings->>'triple_double')::numeric, 0) ELSE 0 END;

  RETURN v_total;
END;
$$;

-- ============================================================
-- Waiver wire: auto-set clears_at on insert
-- clears_at = placed_on_waivers_at + 48 hours
-- ============================================================

CREATE OR REPLACE FUNCTION set_waiver_clears_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.clears_at = NEW.placed_on_waivers_at + INTERVAL '48 hours';
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_waiver_clears_at
  BEFORE INSERT ON waiver_wire_log
  FOR EACH ROW EXECUTE FUNCTION set_waiver_clears_at();

-- ============================================================
-- Trade: auto-set veto_window_expires_at on acceptance
-- veto_window_expires_at = accepted_at + 24 hours
-- ============================================================

CREATE OR REPLACE FUNCTION set_veto_window()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
    NEW.accepted_at = now();
    NEW.veto_window_expires_at = now() + INTERVAL '24 hours';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_trade_veto_window
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION set_veto_window();

-- NOTE: Profile creation on signup is handled in the application layer
-- (lib/auth.ts signUp function) via a direct INSERT after auth.signUp().
-- A trigger on auth.users was attempted but removed due to search_path
-- scoping issues when referencing public.profiles from the auth schema.
-- See migration 20260226000004_fix_profile_creation.sql.
