-- Canonical SQL source for public.projection_stat_fantasy_points.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.projection_stat_fantasy_points(
  p_points numeric,
  p_rebounds numeric,
  p_assists numeric,
  p_steals numeric,
  p_blocks numeric,
  p_three_pointers_made numeric,
  p_turnovers numeric,
  p_field_goals_made numeric,
  p_field_goals_attempted numeric,
  p_free_throws_made numeric,
  p_free_throws_attempted numeric,
  p_double_doubles numeric,
  p_triple_doubles numeric,
  p_scoring_settings jsonb
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH category_counts AS (
    SELECT (
      (COALESCE(p_points, 0) >= 10)::int +
      (COALESCE(p_rebounds, 0) >= 10)::int +
      (COALESCE(p_assists, 0) >= 10)::int +
      (COALESCE(p_steals, 0) >= 10)::int +
      (COALESCE(p_blocks, 0) >= 10)::int
    ) AS ten_plus_categories
  )
  SELECT ROUND((
    COALESCE(p_points, 0)              * COALESCE((p_scoring_settings->>'points')::numeric, 0) +
    COALESCE(p_rebounds, 0)            * COALESCE((p_scoring_settings->>'rebounds')::numeric, 0) +
    COALESCE(p_assists, 0)             * COALESCE((p_scoring_settings->>'assists')::numeric, 0) +
    COALESCE(p_steals, 0)              * COALESCE((p_scoring_settings->>'steals')::numeric, 0) +
    COALESCE(p_blocks, 0)              * COALESCE((p_scoring_settings->>'blocks')::numeric, 0) +
    COALESCE(p_three_pointers_made, 0) * COALESCE((p_scoring_settings->>'three_pointers_made')::numeric, 0) +
    COALESCE(p_turnovers, 0)           * COALESCE((p_scoring_settings->>'turnovers')::numeric, 0) +
    COALESCE(p_field_goals_made, 0)    * COALESCE((p_scoring_settings->>'field_goals_made')::numeric, 0) +
    COALESCE(p_field_goals_attempted, 0) * COALESCE((p_scoring_settings->>'field_goals_attempted')::numeric, 0) +
    COALESCE(p_free_throws_made, 0)    * COALESCE((p_scoring_settings->>'free_throws_made')::numeric, 0) +
    COALESCE(p_free_throws_attempted, 0) * COALESCE((p_scoring_settings->>'free_throws_attempted')::numeric, 0) +
    COALESCE(p_double_doubles, CASE WHEN ten_plus_categories >= 2 THEN 1 ELSE 0 END) *
      COALESCE((p_scoring_settings->>'double_double')::numeric, 0) +
    COALESCE(p_triple_doubles, CASE WHEN ten_plus_categories >= 3 THEN 1 ELSE 0 END) *
      COALESCE((p_scoring_settings->>'triple_double')::numeric, 0)
  ), 2)
  FROM category_counts;
$$;
