-- ============================================================
-- ROLLBACK for 20260422000003_security_fixes_v2.sql
--
-- Reverts the three automated fixes so you can restore the prior
-- state if something goes wrong.
--
-- NOTE: This does NOT revert the auth_leaked_password_protection
-- Dashboard change (that is a one-way toggle).
-- ============================================================

-- ------------------------------------------------------------
-- PART 1: Revert mv_player_season_averages to public
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'mv_player_season_averages'
      AND n.nspname = 'analytics'
      AND c.relkind = 'm'
  ) THEN
    PERFORM cron.unschedule('refresh-player-season-averages');

    DROP VIEW IF EXISTS public.mv_player_season_averages;
    DROP MATERIALIZED VIEW analytics.mv_player_season_averages CASCADE;
  END IF;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_player_season_averages AS
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
  ON public.mv_player_season_averages(player_id, season_year);

GRANT SELECT ON public.mv_player_season_averages TO authenticated, anon;

SELECT cron.schedule(
  'refresh-player-season-averages',
  '30 12 * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_player_season_averages$$
);

-- ------------------------------------------------------------
-- PART 2: Revert pg_jsonschema to public
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pg_jsonschema'
      AND extnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'extensions')
  ) THEN
    ALTER TABLE leagues DROP CONSTRAINT IF EXISTS scoring_settings_schema;
    DROP EXTENSION IF EXISTS pg_jsonschema;
    CREATE EXTENSION pg_jsonschema WITH SCHEMA public;

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
  END IF;
END $$;

-- ------------------------------------------------------------
-- PART 3: Revert pg_net to public
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pg_net'
      AND extnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'extensions')
  ) THEN
    ALTER EXTENSION pg_net SET SCHEMA public;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not move pg_net back to public schema: %', SQLERRM;
END $$;
