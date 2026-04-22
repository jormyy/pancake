-- ============================================================
-- Security fixes for Supabase linter warnings
--
-- 1. function_search_path_mutable — add SET search_path = public
--    to all 12 affected functions to prevent schema-injection attacks.
--
-- 2. extension_in_public — move unaccent and pg_jsonschema to an
--    `extensions` schema so they are no longer in the public API.
--    pg_net is excluded: its objects live in the `net` schema, not
--    public, so ALTER EXTENSION would be a no-op / unsupported.
--
-- 3. materialized_view_in_api — revoke anon SELECT on
--    mv_player_season_averages (authenticated users only).
--
-- Note: "Leaked Password Protection Disabled" must be enabled in
--   Supabase Dashboard → Authentication → Security → Password Strength.
--   It cannot be set via a migration.
-- ============================================================


-- ============================================================
-- PART 1: Move extensions out of the public schema
-- ============================================================

CREATE SCHEMA IF NOT EXISTS extensions;

-- unaccent: used only in name_key() below. Safe to move.
ALTER EXTENSION unaccent SET SCHEMA extensions;

-- pg_jsonschema: used in leagues.scoring_settings CHECK constraint.
-- Must drop the constraint, move the extension, then recreate.
ALTER TABLE leagues DROP CONSTRAINT IF EXISTS scoring_settings_schema;
ALTER EXTENSION pg_jsonschema SET SCHEMA extensions;
ALTER TABLE leagues
  ADD CONSTRAINT scoring_settings_schema CHECK (
    extensions.jsonb_matches_schema(
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


-- ============================================================
-- PART 2: Fix mutable search_path on all affected functions
-- ============================================================

-- set_updated_at ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- seed_default_lineup_slots ───────────────────────────────────
CREATE OR REPLACE FUNCTION seed_default_lineup_slots()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
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

-- seed_default_scoring_settings ───────────────────────────────
CREATE OR REPLACE FUNCTION seed_default_scoring_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
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

-- set_waiver_clears_at ────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_waiver_clears_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.clears_at = NEW.placed_on_waivers_at + INTERVAL '48 hours';
  RETURN NEW;
END;
$$;

-- set_veto_window ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_veto_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
    NEW.accepted_at = now();
    NEW.veto_window_expires_at = now() + INTERVAL '24 hours';
  END IF;
  RETURN NEW;
END;
$$;

-- set_pgs_game_date ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_pgs_game_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  SELECT game_date INTO NEW.game_date FROM nba_games WHERE id = NEW.game_id;
  RETURN NEW;
END;
$$;

-- set_bid_league_id ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_bid_league_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
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

-- name_key ────────────────────────────────────────────────────
-- Also updated to use extensions.unaccent after the schema move above.
CREATE OR REPLACE FUNCTION name_key(n text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT
  SET search_path = public
  AS $$
  SELECT trim(regexp_replace(
    regexp_replace(
      regexp_replace(extensions.unaccent(lower(n)), '\s+(jr\.?|sr\.?|ii|iii|iv|v)$', ''),
      '[^a-z0-9 ]', '', 'g'
    ),
    '\s+', ' ', 'g'
  ))
$$;

-- count_final_games_missing_stats ─────────────────────────────
CREATE OR REPLACE FUNCTION count_final_games_missing_stats(season_year_param int)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)
  FROM nba_games g
  WHERE g.season_year = season_year_param
    AND g.status = 'Final'
    AND NOT EXISTS (
      SELECT 1 FROM player_game_stats s WHERE s.game_id = g.id
    );
$$;

-- merge_players ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION merge_players(winner_id uuid, loser_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF winner_id = loser_id THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = winner_id) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = loser_id)  THEN RETURN; END IF;

  UPDATE players
    SET sleeper_id = NULL
    WHERE id = loser_id AND sleeper_id IS NOT NULL
      AND (SELECT sleeper_id FROM players WHERE id = winner_id) IS NULL;

  UPDATE players
    SET sleeper_id = (SELECT sleeper_id FROM players WHERE id = loser_id)
    WHERE id = winner_id AND sleeper_id IS NULL
      AND (SELECT sleeper_id FROM players WHERE id = loser_id) IS NOT NULL;

  UPDATE roster_players SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE weekly_lineups SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_projections
    WHERE player_id = loser_id
      AND (season_year, week_number) IN (
        SELECT season_year, week_number FROM player_projections WHERE player_id = winner_id
      );
  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE nominations         SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE waiver_claims       SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE waiver_claims       SET drop_player_id = winner_id WHERE drop_player_id = loser_id;
  UPDATE waiver_wire_log     SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE trade_items         SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE roster_transactions SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_game_stats
    WHERE player_id = loser_id
      AND game_id IN (SELECT game_id FROM player_game_stats WHERE player_id = winner_id);
  UPDATE player_game_stats SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM players WHERE id = loser_id;
END;
$$;

-- merge_duplicate_players ─────────────────────────────────────
CREATE OR REPLACE FUNCTION merge_duplicate_players()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      (array_agg(id ORDER BY (sleeper_id IS NOT NULL) DESC, created_at ASC))[1] AS winner_id,
      unnest((array_agg(id ORDER BY (sleeper_id IS NOT NULL) DESC, created_at ASC))[2:]) AS loser_id
    FROM players
    WHERE nba_id IS NOT NULL
    GROUP BY nba_id
    HAVING count(*) > 1
  LOOP
    PERFORM merge_players(r.winner_id, r.loser_id);
  END LOOP;

  FOR r IN
    SELECT DISTINCT ON (LEAST(p1.id::text, p2.id::text))
      p1.id   AS id1,
      p2.id   AS id2,
      (p1.sleeper_id IS NOT NULL)::int + (p1.nba_id IS NOT NULL)::int AS score1,
      (p2.sleeper_id IS NOT NULL)::int + (p2.nba_id IS NOT NULL)::int AS score2
    FROM players p1
    JOIN players p2
      ON p1.id < p2.id
      AND p1.nba_team IS NOT NULL
      AND p1.nba_team = p2.nba_team
      AND name_key(p1.first_name || ' ' || p1.last_name)
        = name_key(p2.first_name || ' ' || p2.last_name)
  LOOP
    IF r.score1 >= r.score2 THEN
      PERFORM merge_players(r.id1, r.id2);
    ELSE
      PERFORM merge_players(r.id2, r.id1);
    END IF;
  END LOOP;

  FOR r IN
    SELECT DISTINCT ON (LEAST(p1.id::text, p2.id::text))
      p1.id   AS id1,
      p2.id   AS id2,
      (p1.sleeper_id IS NOT NULL)::int + (p1.nba_id IS NOT NULL)::int AS score1,
      (p2.sleeper_id IS NOT NULL)::int + (p2.nba_id IS NOT NULL)::int AS score2
    FROM players p1
    JOIN players p2
      ON p1.id < p2.id
      AND p1.nba_team IS NOT NULL
      AND p1.nba_team = p2.nba_team
      AND name_key(p1.last_name) = name_key(p2.last_name)
      AND (
        name_key(p2.first_name) LIKE name_key(p1.first_name) || '%'
        OR name_key(p1.first_name) LIKE name_key(p2.first_name) || '%'
      )
  LOOP
    IF r.score1 >= r.score2 THEN
      PERFORM merge_players(r.id1, r.id2);
    ELSE
      PERFORM merge_players(r.id2, r.id1);
    END IF;
  END LOOP;
END;
$$;

-- compute_fantasy_points ──────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_fantasy_points(
  p_stat_id   uuid,
  p_league_id uuid
)
RETURNS numeric LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
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
    COALESCE(v_stats.points,                  0) * COALESCE((v_settings->>'points')::numeric,                0) +
    COALESCE(v_stats.rebounds,                0) * COALESCE((v_settings->>'rebounds')::numeric,              0) +
    COALESCE(v_stats.assists,                 0) * COALESCE((v_settings->>'assists')::numeric,               0) +
    COALESCE(v_stats.steals,                  0) * COALESCE((v_settings->>'steals')::numeric,                0) +
    COALESCE(v_stats.blocks,                  0) * COALESCE((v_settings->>'blocks')::numeric,                0) +
    COALESCE(v_stats.turnovers,               0) * COALESCE((v_settings->>'turnovers')::numeric,             0) +
    COALESCE(v_stats.three_pointers_made,     0) * COALESCE((v_settings->>'three_pointers_made')::numeric,   0) +
    COALESCE(v_stats.field_goals_made,        0) * COALESCE((v_settings->>'field_goals_made')::numeric,      0) +
    COALESCE(v_stats.field_goals_attempted,   0) * COALESCE((v_settings->>'field_goals_attempted')::numeric, 0) +
    COALESCE(v_stats.free_throws_made,        0) * COALESCE((v_settings->>'free_throws_made')::numeric,      0) +
    COALESCE(v_stats.free_throws_attempted,   0) * COALESCE((v_settings->>'free_throws_attempted')::numeric, 0) +
    CASE WHEN v_stats.double_double = true
      THEN COALESCE((v_settings->>'double_double')::numeric, 0) ELSE 0 END +
    CASE WHEN v_stats.triple_double = true
      THEN COALESCE((v_settings->>'triple_double')::numeric, 0) ELSE 0 END;

  RETURN v_total;
END;
$$;


-- ============================================================
-- PART 3: Revoke anon access to mv_player_season_averages
-- The app only queries this as an authenticated user.
-- ============================================================

REVOKE SELECT ON mv_player_season_averages FROM anon;
