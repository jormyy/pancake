-- ============================================================
-- Security fixes v2 — resolves remaining Supabase linter warnings
--
-- 1. extension_in_public (pg_net)     → move to extensions schema
-- 2. extension_in_public (pg_jsonschema) → drop + recreate in extensions
-- 3. materialized_view_in_api (mv_player_season_averages) → move to
--    analytics schema; expose via public view proxy so frontend
--    queries remain unchanged.
-- 4. auth_leaked_password_protection  → see MANUAL STEP note below
-- ============================================================

-- ============================================================
-- PART 1: Move pg_net to extensions schema
--
-- pg_net is relocatable (relocatable = true in its control file).
-- Its actual functions live in the dedicated "net" schema; moving
-- the extension control record does not break invoke_edge_function().
-- ============================================================

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pg_net'
      AND extnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    ALTER EXTENSION pg_net SET SCHEMA extensions;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not move pg_net to extensions schema: %', SQLERRM;
END $$;


-- ============================================================
-- PART 2: Move pg_jsonschema to extensions schema
--
-- pg_jsonschema is NOT relocatable (relocatable = false), so we
-- must drop + recreate it.  The only dependent object is the
-- scoring_settings_schema CHECK constraint on leagues.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pg_jsonschema'
      AND extnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    -- 1. Remove dependent constraint
    ALTER TABLE leagues DROP CONSTRAINT IF EXISTS scoring_settings_schema;

    -- 2. Drop and recreate in extensions
    DROP EXTENSION IF EXISTS pg_jsonschema;
    CREATE EXTENSION pg_jsonschema WITH SCHEMA extensions;

    -- 3. Re-create constraint (fully qualified function name)
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
  END IF;
END $$;


-- ============================================================
-- PART 3: Move mv_player_season_averages out of public schema
--
-- Materialized views cannot have RLS, so they must not live in
-- API-exposed schemas.  We move the MV to the "analytics" schema
-- and create a public view proxy with the same name so the
-- frontend (lib/players.ts, lib/lineup.ts) requires zero changes.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS analytics;

-- Only migrate if the MV is still in public (idempotent)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'mv_player_season_averages'
      AND n.nspname = 'public'
      AND c.relkind = 'm'
  ) THEN
    -- Remove the old cron refresh job
    PERFORM cron.unschedule('refresh-player-season-averages');

    -- Drop the public MV
    DROP MATERIALIZED VIEW public.mv_player_season_averages CASCADE;
  END IF;
END $$;

-- Create the MV in analytics (idempotent)
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_player_season_averages AS
SELECT
  player_id,
  season_year,
  COUNT(*)                                       AS games_played,
  ROUND(AVG(points)::numeric,             1)     AS avg_points,
  ROUND(AVG(rebounds)::numeric,           1)     AS avg_rebounds,
  ROUND(AVG(assists)::numeric,            1)     AS avg_assists,
  ROUND(AVG(steals)::numeric,             2)     AS avg_steals,
  ROUND(AVG(blocks)::numeric,             2)     AS avg_blocks,
  ROUND(AVG(turnovers)::numeric,          2)     AS avg_turnovers,
  ROUND(AVG(three_pointers_made)::numeric,2)     AS avg_three_pointers_made,
  ROUND(AVG(field_goals_made)::numeric,   2)     AS avg_field_goals_made,
  ROUND(AVG(field_goals_attempted)::numeric,2)   AS avg_field_goals_attempted,
  ROUND(AVG(free_throws_made)::numeric,   2)     AS avg_free_throws_made,
  ROUND(AVG(free_throws_attempted)::numeric,2)   AS avg_free_throws_attempted,
  ROUND(AVG(minutes_played)::numeric,     1)     AS avg_minutes_played,
  COUNT(*) FILTER (WHERE double_double = true)   AS double_doubles,
  COUNT(*) FILTER (WHERE triple_double = true)   AS triple_doubles
FROM player_game_stats
WHERE NOT did_not_play
GROUP BY player_id, season_year;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_player_season_averages
  ON analytics.mv_player_season_averages(player_id, season_year);

-- Public view proxy: keeps the frontend query interface identical.
-- security_invoker = true: permissions are evaluated as the querying user,
-- not the view creator, which satisfies the security_definer_view linter rule.
CREATE OR REPLACE VIEW public.mv_player_season_averages
  WITH (security_invoker = true)
AS
  SELECT * FROM analytics.mv_player_season_averages;

GRANT SELECT ON public.mv_player_season_averages TO authenticated, anon;

-- Re-schedule the daily refresh against the analytics MV
SELECT cron.schedule(
  'refresh-player-season-averages',
  '30 12 * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_player_season_averages$$
);


-- ============================================================
-- PART 4: MANUAL STEP — Enable Leaked Password Protection
--
-- This setting cannot be configured via SQL migration or CLI.
-- Action required in the Supabase Dashboard:
--   Project → Authentication → Security → Password Strength
--   → Enable "Prevent use of leaked passwords"
--
-- Reference:
--   https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
-- ============================================================
